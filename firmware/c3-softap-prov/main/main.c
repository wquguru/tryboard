// 验收固件（C-02）：板子自建热点配网。
// 第一次上电：开热点 TryBoard-Setup（192.168.4.1），DNS 劫持所有域名 → 手机弹「需要登录」，
// 配网页收 Wi-Fi 名称和密码 → 存 NVS → 关热点去连家里的路由器 → 拿到 IP 后重启，
// 重启后从 NVS 读出来直接连（验证「记住」）。密码错连不上三次就清掉记住的配置、重新打开热点。
#include <stdio.h>
#include <string.h>
#include <ctype.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_mac.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_http_server.h"
#include "lwip/sockets.h"

#ifndef AP_SSID
#define AP_SSID "TryBoard-Setup"
#endif
#ifndef AP_PASS
#define AP_PASS ""
#endif
#ifndef TAG_OK
#define TAG_OK "c3-softap-prov"
#endif

#define BIT_SUBMIT 1

static EventGroupHandle_t eg;
static char sta_ssid[33], sta_pass[65];
static bool from_nvs;
static int fails;

static const char PAGE[] =
    "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width'>"
    "<title>设备配网</title></head><body><h1>设备配网</h1>"
    "<p>这一页是你的固件发出来的</p>"
    "<form method=post action=/save>"
    "<label>Wi-Fi 名称 <input name=ssid></label>"
    "<label>密码 <input name=pass type=password></label>"
    "<button type=submit>保存并连接</button></form></body></html>";

static void start_ap(void);

static esp_err_t page_get(httpd_req_t *req)
{
    printf("HTTP GET %s\n", req->uri);
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, PAGE, HTTPD_RESP_USE_STRLEN);
}

// 系统的联网探测（generate_204、hotspot-detect.html 等）一律跳到配网页：手机据此认出「需要登录」
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

// 取表单字段并做 URL 解码（+ → 空格，%XX）
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
    form_field(body, "ssid", sta_ssid, sizeof(sta_ssid));
    form_field(body, "pass", sta_pass, sizeof(sta_pass));
    printf("收到 SSID=%s（密码 %d 位）\n", sta_ssid, (int)strlen(sta_pass));
    nvs_handle_t h;
    if (nvs_open("prov", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, "ssid", sta_ssid);
        nvs_set_str(h, "pass", sta_pass);
        nvs_commit(h);
        nvs_close(h);
        printf("已存进 NVS\n");
    }
    char resp[200];
    snprintf(resp, sizeof(resp),
             "<!doctype html><html><head><meta charset=utf-8><title>已保存</title></head>"
             "<body><h1>已保存</h1><p>正在连接 %s</p></body></html>",
             sta_ssid);
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req, resp, HTTPD_RESP_USE_STRLEN);
    xEventGroupSetBits(eg, BIT_SUBMIT);
    return ESP_OK;
}

static void start_http(void)
{
    httpd_handle_t srv = NULL;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    ESP_ERROR_CHECK(httpd_start(&srv, &cfg));
    httpd_uri_t root = {.uri = "/", .method = HTTP_GET, .handler = page_get};
    httpd_uri_t save = {.uri = "/save", .method = HTTP_POST, .handler = save_post};
    httpd_uri_t other = {.uri = "/*", .method = HTTP_GET, .handler = redirect_get};
    httpd_register_uri_handler(srv, &root);
    httpd_register_uri_handler(srv, &save);
    httpd_register_uri_handler(srv, &other);
    printf("配网页 http://192.168.4.1/ 已就绪\n");
}

// DNS 劫持：所有 A 查询都答 192.168.4.1
static void dns_task(void *arg)
{
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = htonl(INADDR_ANY)};
    bind(s, (struct sockaddr *)&a, sizeof(a));
    uint8_t buf[300];
    for (;;) {
        struct sockaddr_in from;
        socklen_t fl = sizeof(from);
        int n = recvfrom(s, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&from, &fl);
        if (n < 12) continue;
        // 只看第一个问题：域名到 QTYPE 之前
        int q = 12;
        char name[100];
        int nl = 0;
        while (q < n && buf[q] && nl < 90) {
            int l = buf[q++];
            if (nl) name[nl++] = '.';
            for (int i = 0; i < l && q < n && nl < 98; i++) name[nl++] = buf[q++];
        }
        name[nl] = 0;
        q += 5; // 0 结尾 + QTYPE + QCLASS
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
}

static void start_ap(void)
{
    wifi_config_t ac = {0};
    strcpy((char *)ac.ap.ssid, AP_SSID);
    ac.ap.ssid_len = strlen(AP_SSID);
    strcpy((char *)ac.ap.password, AP_PASS);
    ac.ap.channel = 1;
    ac.ap.max_connection = 4;
    ac.ap.authmode = strlen(AP_PASS) ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ac));
    printf("打开热点 %s（%s）\n", AP_SSID, strlen(AP_PASS) ? "WPA2" : "开放");
}

static void connect_sta(void)
{
    wifi_config_t wc = {0};
    strcpy((char *)wc.sta.ssid, sta_ssid);
    strcpy((char *)wc.sta.password, sta_pass);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    printf("连接 %s ...\n", sta_ssid);
    esp_wifi_connect();
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_AP_START) {
        printf("热点已启动\n");
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        wifi_event_ap_staconnected_t *e = data;
        printf("手机连上热点 " MACSTR " aid=%d\n", MAC2STR(e->mac), e->aid);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STADISCONNECTED) {
        wifi_event_ap_stadisconnected_t *e = data;
        printf("手机离开热点 " MACSTR "\n", MAC2STR(e->mac));
    } else if (base == IP_EVENT && id == IP_EVENT_AP_STAIPASSIGNED) {
        ip_event_ap_staipassigned_t *e = data;
        printf("给手机分配 IP " IPSTR "\n", IP2STR(&e->ip));
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        wifi_event_sta_connected_t *e = data;
        printf("已连接 %.*s ch=%d\n", e->ssid_len, (char *)e->ssid, e->channel);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = data;
        fails++;
        printf("断开 reason=%d（第 %d 次）\n", e->reason, fails);
        if (fails < 3) {
            esp_wifi_connect();
        } else {
            printf("连不上 %s，清掉记住的 Wi-Fi，重新打开热点\n", sta_ssid);
            nvs_handle_t h;
            if (nvs_open("prov", NVS_READWRITE, &h) == ESP_OK) {
                nvs_erase_all(h);
                nvs_commit(h);
                nvs_close(h);
            }
            fails = 0;
            from_nvs = false;
            start_ap();
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        fails = 0;
        printf("拿到 IP " IPSTR " 网关 " IPSTR "\n", IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw));
        if (from_nvs) {
            printf("TRYBOARD_OK " TAG_OK " 重启后记住了 %s\n", sta_ssid);
        } else {
            printf("配网完成，重启验证 NVS 里的记忆\n");
            xEventGroupSetBits(eg, 2);
        }
    }
}

void app_main(void)
{
    eg = xEventGroupCreate();
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    nvs_handle_t h;
    size_t l1 = sizeof(sta_ssid), l2 = sizeof(sta_pass);
    if (nvs_open("prov", NVS_READONLY, &h) == ESP_OK) {
        if (nvs_get_str(h, "ssid", sta_ssid, &l1) == ESP_OK && nvs_get_str(h, "pass", sta_pass, &l2) == ESP_OK &&
            sta_ssid[0]) {
            from_nvs = true;
        }
        nvs_close(h);
    }
    if (from_nvs) {
        printf("NVS 里记着 Wi-Fi：%s，直接连接\n", sta_ssid);
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_start());
        connect_sta();
        return;
    }
    start_ap();
    ESP_ERROR_CHECK(esp_wifi_start());
    start_http();
    xTaskCreate(dns_task, "dns", 3072, NULL, 5, NULL);
    for (;;) {
        EventBits_t b = xEventGroupWaitBits(eg, BIT_SUBMIT | 2, true, false, portMAX_DELAY);
        if (b & BIT_SUBMIT) {
            // 先让配网页的回复发完，再关热点
            vTaskDelay(pdMS_TO_TICKS(500));
            printf("关掉热点，去连 %s\n", sta_ssid);
            fails = 0;
            connect_sta();
        }
        if (b & 2) {
            vTaskDelay(pdMS_TO_TICKS(300));
            esp_restart();
        }
    }
}
