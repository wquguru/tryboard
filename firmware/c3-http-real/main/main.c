// 示例 / 验收固件（C-03）：连上虚拟 Wi-Fi 后依次访问
//   1) tryboard.local —— 始终由浏览器里的虚拟服务器回答；
//   2) example.com    —— 打开「真实网络」后经浏览器 fetch 真发出去，对方不给跨域头，浏览器拦下（演示 CORS 失败）；
//   3) httpbin.org/get —— 对方给跨域头，拿到真实回复。
// 没开「真实网络」时 2) 3) 也由虚拟服务器回答（example.com 回首页、httpbin.org/get 回 404），固件照样跑完。
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "nvs_flash.h"

static EventGroupHandle_t eg;

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        printf("断开，重连\n");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        printf("拿到 IP " IPSTR "\n", IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(eg, 1);
    }
}

static char body[2048];

// 返回 HTTP 状态码（打不开返回 -1），正文放进 body
static int get(const char *url)
{
    // 真实网络的往返按浏览器实测折算成模拟时间，可能要几百毫秒到几秒：超时放宽到 15 秒
    esp_http_client_config_t c = {.url = url, .timeout_ms = 15000};
    esp_http_client_handle_t h = esp_http_client_init(&c);
    int st = -1;
    body[0] = 0;
    if (esp_http_client_open(h, 0) == ESP_OK) {
        esp_http_client_fetch_headers(h);
        int n = esp_http_client_read_response(h, body, sizeof(body) - 1);
        body[n > 0 ? n : 0] = 0;
        st = esp_http_client_get_status_code(h);
        printf("GET %s → %d，%d 字节\n", url, st, n);
    } else {
        printf("GET %s 打开失败（超时或被拒）\n", url);
    }
    esp_http_client_cleanup(h);
    return st;
}

void app_main(void)
{
    eg = xEventGroupCreate();
    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    wifi_config_t wc = {0};
    strcpy((char *)wc.sta.ssid, "TryBoard-WiFi");
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
    xEventGroupWaitBits(eg, 1, false, true, portMAX_DELAY);

    if (get("http://tryboard.local/hello.txt") == 200) printf("正文：%s", body);

    int st = get("http://example.com/");
    if (strncmp(body, "TRYBOARD_REALNET_ERROR", 22) == 0) {
        // 正文形如 "TRYBOARD_REALNET_ERROR cors\n"：后面是浏览器给的原因代号
        printf("example.com：浏览器没放行，原因%s", body + 22);
    } else if (strstr(body, "TRYBOARD_HTTP_OK")) {
        printf("example.com：虚拟服务器回答（没开真实网络）\n");
    } else if (st == 200) {
        printf("example.com：真实回复\n");
    }

    st = get("http://httpbin.org/get");
    // 只打印回显的 url 字段：httpbin 的回复里还有请求方的公网 IP，不往串口里写
    char *u = strstr(body, "\"url\": \"");
    if (st == 200 && u) {
        u += 8;
        char *e = strchr(u, '"');
        if (e) *e = 0;
        printf("httpbin.org：真实回复，url=%s\n", u);
    } else if (st == 404) {
        printf("httpbin.org：虚拟服务器回 404（没开真实网络）\n");
    } else if (strncmp(body, "TRYBOARD_REALNET_ERROR", 22) == 0) {
        printf("httpbin.org：浏览器没放行\n");
    }
    printf("TRYBOARD_OK c3-http-real\n");
}
