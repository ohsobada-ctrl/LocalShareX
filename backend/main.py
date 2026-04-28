import os
import shutil
from typing import Dict, Any
from fastapi import FastAPI, UploadFile, Form, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import asyncio

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
TEMP_DIR = "temp_uploads"

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Dict[str, Any]] = {}

    async def connect(self, websocket: WebSocket, client_id: str, device_name: str):
        await websocket.accept()
        self.active_connections[client_id] = {
            "ws": websocket,
            "name": device_name
        }
        await self.broadcast_devices()

    async def disconnect(self, websocket: WebSocket, client_id: str):
        if client_id in self.active_connections:
            if self.active_connections[client_id]["ws"] == websocket:
                del self.active_connections[client_id]
                await self.broadcast_devices()

    async def send_personal_message(self, message: dict, client_id: str) -> bool:
        if client_id in self.active_connections:
            ws = self.active_connections[client_id]["ws"]
            try:
                await ws.send_json(message)
                return True
            except:
                return False
        return False

    async def broadcast_devices(self):
        devices = [{"id": cid, "name": data["name"]} for cid, data in self.active_connections.items()]
        for cid, data in self.active_connections.items():
            try:
                other_devices = [d for d in devices if d["id"] != cid]
                await data["ws"].send_json({"type": "device_list", "devices": other_devices})
            except:
                pass

manager = ConnectionManager()

@app.get("/")
def read_root():
    return {"status": "LocalShare X Backend is running"}

@app.websocket("/ws/{client_id}/{device_name}")
async def websocket_endpoint(websocket: WebSocket, client_id: str, device_name: str):
    await manager.connect(websocket, client_id, device_name)
    try:
        while True:
            # We can receive signaling messages here (Request Send, Accept, Reject)
            data = await websocket.receive_json()
            
            if data["type"] == "request_batch":
                target_id = data["target_id"]
                success = await manager.send_personal_message({
                    "type": "incoming_batch",
                    "sender_id": client_id,
                    "sender_name": device_name,
                    "batch_id": data["batch_id"],
                    "files": data["files"]
                }, target_id)
                
                if not success:
                    await manager.send_personal_message({
                        "type": "batch_error",
                        "batch_id": data["batch_id"],
                        "error": "Target device is offline or unavailable."
                    }, client_id)
                
            elif data["type"] == "batch_response":
                sender_id = data["sender_id"]
                await manager.send_personal_message({
                    "type": "batch_response_result",
                    "accepted": data["accepted"],
                    "batch_id": data["batch_id"]
                }, sender_id)
                
    except WebSocketDisconnect:
        await manager.disconnect(websocket, client_id)
    except Exception as e:
        await manager.disconnect(websocket, client_id)

@app.post("/upload/chunk")
async def upload_chunk(
    file: UploadFile = File(...),
    file_id: str = Form(...),
    batch_id: str = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
    filename: str = Form(...),
    target_id: str = Form(...)
):
    temp_dir_path = os.path.join(TEMP_DIR, batch_id, file_id)
    os.makedirs(temp_dir_path, exist_ok=True)
    
    chunk_path = os.path.join(temp_dir_path, f"{chunk_index}")
    
    with open(chunk_path, "wb") as buffer:
        buffer.write(await file.read())
        
    received_chunks = len(os.listdir(temp_dir_path))
    progress = int((received_chunks / total_chunks) * 100)
    
    # Notify Target about progress (optional, could just be generic or file-specific)
    await manager.send_personal_message({
        "type": "receive_progress",
        "batch_id": batch_id,
        "file_id": file_id,
        "progress": progress
    }, target_id)
    
    if received_chunks == total_chunks:
        # Reassemble this specific file in the batch directory
        assembled_dir = os.path.join(TEMP_DIR, batch_id, "assembled")
        os.makedirs(assembled_dir, exist_ok=True)
        final_file_path = os.path.join(assembled_dir, filename)
        
        with open(final_file_path, "wb") as final_file:
            for i in range(total_chunks):
                chunk_file = os.path.join(temp_dir_path, str(i))
                try:
                    with open(chunk_file, "rb") as f:
                        final_file.write(f.read())
                except FileNotFoundError:
                    # Handle missing chunk gracefully if it happens during retries
                    pass
                
        # Clean up chunk dir
        shutil.rmtree(temp_dir_path)
        return {"status": "file_completed"}
        
    return {"status": "chunk_received"}

import zipfile

@app.post("/upload/finalize")
async def finalize_batch(batch_id: str = Form(...), target_id: str = Form(...), sender_name: str = Form(...)):
    assembled_dir = os.path.join(TEMP_DIR, batch_id, "assembled")
    
    if not os.path.exists(assembled_dir):
        return {"error": "Batch not found"}
        
    files = os.listdir(assembled_dir)
    if len(files) == 0:
        return {"error": "No files in batch"}
        
    if len(files) == 1:
        # Single file
        filename = files[0]
        final_path = os.path.join(UPLOAD_DIR, filename)
        shutil.move(os.path.join(assembled_dir, filename), final_path)
        download_name = filename
        download_url = f"/download/{filename}"
    else:
        # Multiple files, zip them
        zip_filename = f"{sender_name}_batch_{batch_id}.zip"
        final_path = os.path.join(UPLOAD_DIR, zip_filename)
        with zipfile.ZipFile(final_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for file in files:
                file_path = os.path.join(assembled_dir, file)
                zipf.write(file_path, arcname=file)
        download_name = zip_filename
        download_url = f"/download/{zip_filename}"
        
    # Clean up batch dir
    shutil.rmtree(os.path.join(TEMP_DIR, batch_id))
    
    # Notify Target to download
    await manager.send_personal_message({
        "type": "batch_complete",
        "batch_id": batch_id,
        "filename": download_name,
        "download_url": download_url
    }, target_id)
    
    return {"status": "completed", "download_url": download_url}

@app.get("/download/{filename}")
def download_file(filename: str):
    file_path = os.path.join(UPLOAD_DIR, filename)
    if os.path.exists(file_path):
        return FileResponse(file_path, filename=filename)
    raise HTTPException(status_code=404, detail="File not found")
