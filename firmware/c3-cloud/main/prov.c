// G-05d provisioning portal: TryBoard-Setup hotspot page at 192.168.4.1, form -> NVS "prov", DNS answers 192.168.4.1.
// Written after firmware/c3-softap-prov (our own C-02 firmware); main.c owns the Wi-Fi modes.
#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include <stdbool.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "esp_http_server.h"
#include "lwip/sockets.h"
#include "prov.h"

char prov_ssid[33], prov_pass[65];
static EventGroupHandle_t s_eg;
static EventBits_t s_bit;
static httpd_handle_t s_srv;
static volatile bool s_dns_stop;

static const char PAGE[] =
    "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width'>"
    "<title>设备配网</title></head><body><h1>设备配网</h1>"
    "<p>这一页是你的固件发出来的</p>"
    "<form method=post action=/save>"
    "<label>Wi-Fi 名称 <input name=ssid></label>"
    "<label>密码 <input name=pass type=password></label>"
    "<button type=submit>保存并连接</button></form></body></html>";


static esp_err_t page_get(httpd_req_t *req)
{
    printf("HTTP GET %s\n", req->uri);
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, PAGE, HTTPD_RESP_USE_STRLEN);
}

// OS connectivity checks (generate_204, hotspot-detect.html, ...) all redirect to the portal: phones read that as "sign in"
static esp_err_t redirect_get(httpd_req_t *req)
{
    printf("HTTP GET %s → 跳转配网页\n", req->uri);
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    return httpd_resp_send(req, NULL, 0);
}

static int hexv(char c)
{
    return isdigit((unsigned char)c) ? c - '0' : (tolower((unsigned char)c) - 'a' + 10);
}

// Read a form field and URL-decode it (+ -> space, %XX)
static void form_field(const char *body, const char *key, char *out, size_t cap)
{
    out[0] = 0;
    size_t kl = strlen(key);
    const char *p = body;
    while (p && *p) {
        if (strncmp(p, key, kl) == 0 && p[kl] == '=') {
            p += kl + 1;
            size_t n = 0;
            while (*p && *p != '&' && n + 1 < cap) {
                if (*p == '+') {
                    out[n++] = ' ';
                    p++;
                } else if (*p == '%' && isxdigit((unsigned char)p[1]) && isxdigit((unsigned char)p[2])) {
                    out[n++] = (char)(hexv(p[1]) * 16 + hexv(p[2]));
                    p += 3;
                } else {
                    out[n++] = *p++;
                }
            }
            out[n] = 0;
            return;
        }
        p = strchr(p, '&');
        if (p) p++;
    }
}

static esp_err_t save_post(httpd_req_t *req)
{
    char body[256];
    int len = req->content_len < sizeof(body) - 1 ? req->content_len : sizeof(body) - 1;
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, body + got, len - got);
        if (r <= 0) return ESP_FAIL;
        got += r;
    }
    body[got] = 0;
    form_field(body, "ssid", prov_ssid, sizeof(prov_ssid));
    form_field(body, "pass", prov_pass, sizeof(prov_pass));
    printf("收到 SSID=%s（密码 %d 位）\n", prov_ssid, (int)strlen(prov_pass));
    nvs_handle_t h;
    if (nvs_open("prov", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, "ssid", prov_ssid);
        nvs_set_str(h, "pass", prov_pass);
        nvs_commit(h);
        nvs_close(h);
        printf("已存进 NVS\n");
    }
    char resp[200];
    snprintf(resp, sizeof(resp),
             "<!doctype html><html><head><meta charset=utf-8><title>已保存</title></head>"
             "<body><h1>已保存</h1><p>正在连接 %s</p></body></html>",
             prov_ssid);
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req, resp, HTTPD_RESP_USE_STRLEN);
    xEventGroupSetBits(s_eg, s_bit);
    return ESP_OK;
}

static void start_http(void)
{
    httpd_handle_t srv = NULL;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    ESP_ERROR_CHECK(httpd_start(&srv, &cfg));
    s_srv = srv;
    httpd_uri_t root = {.uri = "/", .method = HTTP_GET, .handler = page_get};
    httpd_uri_t save = {.uri = "/save", .method = HTTP_POST, .handler = save_post};
    httpd_uri_t other = {.uri = "/*", .method = HTTP_GET, .handler = redirect_get};
    httpd_register_uri_handler(srv, &root);
    httpd_register_uri_handler(srv, &save);
    httpd_register_uri_handler(srv, &other);
    printf("配网页 http://192.168.4.1/ 已就绪\n");
}

// DNS hijack: every A query answers 192.168.4.1
static void dns_task(void *arg)
{
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    // Short receive timeout so the task notices prov_stop and closes its own socket
    struct timeval tv = {.tv_sec = 0, .tv_usec = 200000};
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = htonl(INADDR_ANY)};
    bind(s, (struct sockaddr *)&a, sizeof(a));
    uint8_t buf[300];
    for (;;) {
        struct sockaddr_in from;
        socklen_t fl = sizeof(from);
        int n = recvfrom(s, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&from, &fl);
        if (s_dns_stop) break;
        if (n < 12) continue;
        // Only look at the first question: the name up to QTYPE
        int q = 12;
        char name[100];
        int nl = 0;
        while (q < n && buf[q] && nl < 90) {
            int l = buf[q++];
            if (nl) name[nl++] = '.';
            for (int i = 0; i < l && q < n && nl < 98; i++) name[nl++] = buf[q++];
        }
        name[nl] = 0;
        q += 5; // terminating 0 + QTYPE + QCLASS
        if (q > n) continue;
        printf("DNS 劫持 %s → 192.168.4.1\n", name);
        buf[2] = 0x81;
        buf[3] = 0x80;
        buf[6] = 0;
        buf[7] = 1;
        buf[8] = buf[9] = buf[10] = buf[11] = 0;
        uint8_t ans[] = {0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 168, 4, 1};
        memcpy(buf + q, ans, sizeof(ans));
        sendto(s, buf, q + sizeof(ans), 0, (struct sockaddr *)&from, fl);
    }
    close(s);
    vTaskDelete(NULL);
}


void prov_start(EventGroupHandle_t eg, EventBits_t submit_bit)
{
    s_eg = eg;
    s_bit = submit_bit;
    s_dns_stop = false;
    start_http();
    xTaskCreate(dns_task, "dns", 3072, NULL, 5, NULL);
}

void prov_stop(void)
{
    if (s_srv) {
        httpd_stop(s_srv);
        s_srv = NULL;
    }
    s_dns_stop = true;
}
