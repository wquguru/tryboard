// G-05d phone provisioning portal for c3-cloud: page, form POST, DNS hijack (same approach as c3-softap-prov, C-02)
#pragma once
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

// Filled by the form POST before the submit bit is set
extern char prov_ssid[33], prov_pass[65];

void prov_start(EventGroupHandle_t eg, EventBits_t submit_bit);
void prov_stop(void);
