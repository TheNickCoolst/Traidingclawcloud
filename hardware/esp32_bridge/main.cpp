/**
 * TradingClaw - IoT Hardware Bridge (ESP32)
 * 
 * This generic Arduino/PlatformIO C++ schematic connects an ESP32 microcontroller
 * to TradingClaw's Phase 4 backend webhook server. 
 * Use this to wire physical buttons, motion sensors, or temperature alarms to the AI.
 */

#include <WiFi.h>
#include <HTTPClient.h>

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// The IP Address of the machine running Node.js / Docker
const char* serverUrl = "http://192.168.1.100:3000/webhook/iot_hardware_button";

// Change this based on your specific sensor pin
const int SENSOR_PIN = 4;
int lastSensorState = LOW;

void setup() {
  Serial.begin(115200);
  pinMode(SENSOR_PIN, INPUT_PULLUP);

  Serial.print("Connecting to WiFi");
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConnected!");
}

void triggerAgent() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    // Construct a simple JSON payload the agent can parse
    String payload = "{\"device\": \"ESP32_Primary\", \"event\": \"Button_Pressed\", \"message\": \"Physical alert button was triggered in the office.\"}";
    
    int httpResponseCode = http.POST(payload);
    
    if (httpResponseCode > 0) {
      Serial.printf("Agent Webhook Triggered. HTTP Response code: %d\n", httpResponseCode);
    } else {
      Serial.printf("Error Code: %d\n", httpResponseCode);
    }
    http.end();
  }
}

void loop() {
  int currentState = digitalRead(SENSOR_PIN);
  
  // Transition check (assuming active LOW button)
  if (currentState == LOW && lastSensorState == HIGH) {
      Serial.println("Sensor triggered! Overriding to Agent...");
      triggerAgent();
      delay(2000); // Debounce
  }
  
  lastSensorState = currentState;
  delay(50);
}
