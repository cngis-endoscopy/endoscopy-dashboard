/*
 * ตั้งค่าการเชื่อมต่อ Google Sheets
 * ----------------------------------------------------------------------------
 * ใส่ URL ของ Apps Script Web app (ลงท้ายด้วย /exec) ระหว่างเครื่องหมาย ''
 * ดูวิธีได้ URL นี้ใน README.md ขั้นตอนที่ 3
 */
window.ENDO_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbxOschc6WLVrIX0bQ5xStCk03aTLdq5eOcgsrRU_KSj9LqqvBpAtw2ySmd4DfHDMpW3tg/exec',

  // ดึงข้อมูลใหม่ทุกกี่วินาที (เห็นการแก้ไขของคนอื่นโดยไม่ต้องรีเฟรช)
  refreshSeconds: 30
};
