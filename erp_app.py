import webview

SERVER_URL = "https://your-erp-server.com/index.html"
APP_UA = "AcerERP-Desktop/1.0 key=YOUR_SECRET"

webview.create_window("Acer Biomedical ERP", SERVER_URL, width=1400, height=850)
webview.start(user_agent=APP_UA)