from fastapi import FastAPI, UploadFile, File
from fastapi.responses import HTMLResponse, FileResponse
import os
import uvicorn

app = FastAPI()

UPLOAD_FOLDER = "uploads"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# 🔥 واجهة بسيطة
@app.get("/", response_class=HTMLResponse)
def home():
    return """
    <html>
    <head>
        <title>LocalShare</title>
        <style>
            body {
                background: #0f172a;
                color: white;
                font-family: Arial;
                text-align: center;
                padding: 40px;
            }
            .box {
                border: 2px dashed #38bdf8;
                padding: 40px;
                margin: auto;
                width: 300px;
            }
            button {
                padding: 10px 20px;
                background: #38bdf8;
                border: none;
                color: black;
                cursor: pointer;
            }
        </style>
    </head>
    <body>
        <h1>🚀 LocalShare</h1>
        
        <div class="box">
            <form action="/upload" method="post" enctype="multipart/form-data">
                <input type="file" name="file"><br><br>
                <button type="submit">Upload</button>
            </form>
        </div>

        <h2>📁 Files:</h2>
        <ul id="files"></ul>

        <script>
        fetch('/files')
        .then(res => res.json())
        .then(data => {
            let list = document.getElementById('files');
            data.forEach(file => {
                let li = document.createElement('li');
                li.innerHTML = `<a href="/download/${file}" style="color:#38bdf8">${file}</a>`;
                list.appendChild(li);
            });
        });
        </script>
    </body>
    </html>
    """

# 📤 رفع ملف
@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    filepath = os.path.join(UPLOAD_FOLDER, file.filename)
    with open(filepath, "wb") as f:
        f.write(await file.read())
    return {"status": "uploaded"}

# 📄 عرض الملفات
@app.get("/files")
def list_files():
    return os.listdir(UPLOAD_FOLDER)

# 📥 تحميل ملف
@app.get("/download/{filename}")
def download(filename: str):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    return FileResponse(filepath, filename=filename)

# ▶️ تشغيل السيرفر
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)