// Make a copy named secrets.h and fill it in on your computer.
// Do not paste Wi-Fi passwords, MQTT passwords, or private keys into chat.

#pragma once

#define WIFI_SSID "Anis mobile"
#define WIFI_PASSWORD "1234567890"

#define MQTT_USERNAME "rocket_device_001"
#define MQTT_PASSWORD "Anis@123"

// Download the CA certificate from your EMQX Serverless deployment Overview.
// Paste its full PEM text between the markers below, including BEGIN/END lines.
// This lets the ESP8266 verify it is talking to the genuine TLS broker.
static const char MQTT_CA_CERT[] PROGMEM = R"CERT(
PASTE_EMQX_CA_CERTIFICATE_HERE
)CERT";