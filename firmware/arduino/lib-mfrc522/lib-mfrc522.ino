// F-08a: MFRC522 (miguelbalboa/rfid, Unlicense), after the library's ReadNUID example. C3 SPI default SCK 4 / MISO 5 / MOSI 6, SS 7.
#include <SPI.h>
#include <MFRC522.h>

MFRC522 rfid(7, 3);
int reads = 0;

void setup() {
  Serial.begin(115200);
  delay(100);
  SPI.begin();
  rfid.PCD_Init();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("MFRC522 version 0x%02X\n", v);
}

void loop() {
  delay(50);
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  MFRC522::PICC_Type type = rfid.PICC_GetType(rfid.uid.sak);
  Serial.print("PICC type: ");
  Serial.println(rfid.PICC_GetTypeName(type));
  Serial.print("UID:");
  for (byte i = 0; i < rfid.uid.size; i++) Serial.printf(" %02X", rfid.uid.uidByte[i]);
  Serial.println();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  if (++reads == 2) Serial.println("TRYBOARD_OK lib-mfrc522");
}
