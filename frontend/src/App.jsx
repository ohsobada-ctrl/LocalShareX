import { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import { UploadCloud, CheckCircle2, Shield, Share2, ServerCog, Wifi, Smartphone, Monitor, ShieldAlert, ZapIcon, Edit2, X, Plus, Info, AlertTriangle } from 'lucide-react'

const DEFAULT_HOST = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname
const PORT = 7070
const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB

const getClientId = () => {
  let id = localStorage.getItem("lsx_id")
  if (!id) {
    id = Math.random().toString(36).substring(2, 10)
    localStorage.setItem("lsx_id", id)
  }
  return id
}

const getDeviceName = () => {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return "Android Phone"
  if (/iPhone|iPad/i.test(ua)) return "iOS Device"
  if (/Windows/i.test(ua)) return "Windows PC"
  if (/Mac/i.test(ua)) return "MacBook"
  return "Unknown Device"
}

function App() {
  const [serverIp, setServerIp] = useState(DEFAULT_HOST)
  const [isConnected, setIsConnected] = useState(false)
  const [ws, setWs] = useState(null)

  // Staging files
  const [files, setFiles] = useState([])
  const [activeBatches, setActiveBatches] = useState({})

  const [clientId] = useState(getClientId())

  const [deviceName, setDeviceName] = useState(() => {
    return localStorage.getItem("lsx_name") || getDeviceName()
  })
  const [isEditingName, setIsEditingName] = useState(false)

  const [connectedDevices, setConnectedDevices] = useState([])
  const [selectedTargets, setSelectedTargets] = useState([])

  // UI Enhancements
  const [toasts, setToasts] = useState([])
  const [isDragActive, setIsDragActive] = useState(false)
  const dragCounter = useRef(0)

  const showToast = useCallback((message, type = 'error') => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4000)
  }, [])

  const toggleTarget = (id) => {
    setSelectedTargets(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const [incomingBatches, setIncomingBatches] = useState([])
  const [receiveProgress, setReceiveProgress] = useState({})
  const [downloadables, setDownloadables] = useState([])

  const fileInputRef = useRef(null)

  // Ref for latest state in ws callbacks
  const activeBatchesRef = useRef(activeBatches)
  useEffect(() => { activeBatchesRef.current = activeBatches }, [activeBatches])

  useEffect(() => {
    localStorage.setItem("lsx_name", deviceName)
  }, [deviceName])

  // Global Drag & Drop Handler
  useEffect(() => {
    const handleDragEnter = (e) => {
      e.preventDefault()
      dragCounter.current += 1
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        setIsDragActive(true)
      }
    }
    const handleDragLeave = (e) => {
      e.preventDefault()
      dragCounter.current -= 1
      if (dragCounter.current === 0) {
        setIsDragActive(false)
      }
    }
    const handleDragOver = (e) => e.preventDefault()
    const handleDrop = (e) => {
      e.preventDefault()
      dragCounter.current = 0
      setIsDragActive(false)
      if (e.dataTransfer.files?.length > 0) {
        appendFiles(e.dataTransfer.files)
        showToast("Files added to queue successfully!", "success")
      }
    }

    const doc = document.documentElement
    doc.addEventListener('dragenter', handleDragEnter)
    doc.addEventListener('dragleave', handleDragLeave)
    doc.addEventListener('dragover', handleDragOver)
    doc.addEventListener('drop', handleDrop)

    return () => {
      doc.removeEventListener('dragenter', handleDragEnter)
      doc.removeEventListener('dragleave', handleDragLeave)
      doc.removeEventListener('dragover', handleDragOver)
      doc.removeEventListener('drop', handleDrop)
    }
  }, [])

  useEffect(() => {
    let reconnectTimeout;
    let newWs;

    const connect = () => {
      newWs = new WebSocket(`ws://${serverIp}:${PORT}/ws/${clientId}/${encodeURIComponent(deviceName)}`)

      newWs.onopen = () => setIsConnected(true)

      newWs.onmessage = (event) => {
        const data = JSON.parse(event.data)
        switch (data.type) {
          case 'device_list':
            setConnectedDevices(data.devices)
            break;
          case 'incoming_batch':
            showToast(`${data.sender_name} wants to send you files!`, "success")
            setIncomingBatches(prev => [...prev, data])
            break;
          case 'batch_response_result':
            if (data.accepted) {
              const batch = activeBatchesRef.current[data.batch_id]
              if (batch) startUploadingBatch(data.batch_id, batch.files, batch.target_id)
            } else {
              showToast("Target device rejected the transfer.", "error")
              setActiveBatches(prev => {
                const next = { ...prev }
                delete next[data.batch_id]
                return next
              })
            }
            break;
          case 'batch_error':
            showToast(data.error || "Failed to contact target device.", "error")
            setActiveBatches(prev => {
              const next = { ...prev }
              delete next[data.batch_id]
              return next
            })
            break;
          case 'receive_progress':
            setReceiveProgress(prev => {
              const currentBatch = prev[data.batch_id] || { progress: 0, total_files: activeBatchesRef.current[data.batch_id]?.files?.length || 1 }
              return {
                ...prev,
                [data.batch_id]: { ...currentBatch, [data.file_id]: data.progress }
              }
            })
            break;
          case 'batch_complete':
            setDownloadables(prev => [...prev, data])
            triggerDownload(data.download_url, data.filename)
            break;
          default:
            break;
        }
      }

      newWs.onclose = () => {
        setIsConnected(false)
        reconnectTimeout = setTimeout(connect, 3000)
      }

      setWs(newWs)
    }

    connect()

    return () => {
      clearTimeout(reconnectTimeout)
      if (newWs) {
        newWs.onclose = null // Prevents reconnect
        newWs.close()
      }
    }
  }, [serverIp, deviceName, clientId])

  const handleFileSelect = (e) => {
    if (e.target.files?.length > 0) appendFiles(e.target.files)
  }

  const appendFiles = (newFiles) => {
    const fileArray = Array.from(newFiles).map(f => {
      f.file_id = `${f.name}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
      return f
    })
    setFiles(prev => [...prev, ...fileArray])
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const removeStagingFile = (file_id) => {
    setFiles(prev => prev.filter(f => f.file_id !== file_id))
  }

  const requestBatchTransfer = () => {
    if (selectedTargets.length === 0) return showToast("Please select at least one target device first!", "error")
    if (files.length === 0) return showToast("Please add files first!", "error")

    selectedTargets.forEach(targetId => {
      const batchId = `batch-${targetId}-${Date.now()}`
      const batchFilesInfo = files.map(f => ({
        file_id: f.file_id,
        name: f.name,
        size: f.size
      }))

      ws.send(JSON.stringify({
        type: "request_batch",
        target_id: targetId,
        batch_id: batchId,
        files: batchFilesInfo
      }))

      const targetName = connectedDevices.find(d => d.id === targetId)?.name || "Unknown Device"

      setActiveBatches(prev => ({
        ...prev,
        [batchId]: { status: 'waiting', target_id: targetId, target_name: targetName, files: files, progress: 0 }
      }))
    })

    setFiles([])
    setSelectedTargets([])
    showToast("Transfer requested successfully", "success")
  }

  const startUploadingBatch = async (batchId, batchFiles, targetId) => {
    setActiveBatches(prev => ({ ...prev, [batchId]: { ...prev[batchId], status: 'uploading', progress: 0 } }))

    let totalChunksAll = 0
    let completedChunksAll = 0

    batchFiles.forEach(f => {
      totalChunksAll += Math.ceil(f.size / CHUNK_SIZE)
    })

    const uploadPromises = []

    for (let fIndex = 0; fIndex < batchFiles.length; fIndex++) {
      const file = batchFiles[fIndex]
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        const chunk = file.slice(start, end)

        const formData = new FormData()
        formData.append("file", chunk)
        formData.append("file_id", file.file_id)
        formData.append("batch_id", batchId)
        formData.append("chunk_index", chunkIndex)
        formData.append("total_chunks", totalChunks)
        formData.append("filename", file.name)
        formData.append("target_id", targetId)

        const request = axios.post(`http://${serverIp}:${PORT}/upload/chunk`, formData, {
          headers: { "Content-Type": "multipart/form-data" }
        }).then(() => {
          completedChunksAll++;
          const overallProgress = Math.floor((completedChunksAll / totalChunksAll) * 100)
          setActiveBatches(prev => ({
            ...prev,
            [batchId]: { ...prev[batchId], progress: overallProgress }
          }))
        }).catch(err => {
          console.error("Chunk upload failed", err)
          showToast("Error uploading file chunk over network.", "error")
        })

        uploadPromises.push(request)
        if (uploadPromises.length >= 2) {
          await Promise.all(uploadPromises)
          uploadPromises.length = 0
        }
      }
    }

    if (uploadPromises.length > 0) await Promise.all(uploadPromises)

    // Finalize
    const finalizeData = new FormData()
    finalizeData.append("batch_id", batchId)
    finalizeData.append("target_id", targetId)
    finalizeData.append("sender_name", deviceName)

    axios.post(`http://${serverIp}:${PORT}/upload/finalize`, finalizeData)
      .then(res => {
        setActiveBatches(prev => ({
          ...prev,
          [batchId]: { ...prev[batchId], status: 'completed', progress: 100 }
        }))
      }).catch(err => {
        console.error("Finalize failed", err)
        showToast("Server encountered an error while finalizing files.", "error")
      })
  }

  const handleIncomingResponse = (req, accepted) => {
    ws.send(JSON.stringify({
      type: "batch_response",
      sender_id: req.sender_id,
      batch_id: req.batch_id,
      accepted: accepted
    }))

    setIncomingBatches(prev => prev.filter(r => r.batch_id !== req.batch_id))

    if (accepted) {
      setReceiveProgress(prev => ({ ...prev, [req.batch_id]: { _start: true } }))
    }
  }

  const triggerDownload = (url, name) => {
    const fullUrl = `http://${serverIp}:${PORT}${url}`
    const a = document.createElement('a')
    a.href = fullUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    showToast(`Downloading ${name} safely...`, "success")
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-500/30 overflow-x-hidden relative">

      {/* Toast Notifications */}
      <div className="fixed top-20 right-4 z-[100] flex flex-col gap-3 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-5 py-3 rounded-2xl shadow-2xl border backdrop-blur-xl flex items-center gap-3 transform transition-all duration-300 animate-in fade-in slide-in-from-right-8 ${t.type === 'error' ? 'bg-red-500/10 border-red-500/20 text-red-100' : 'bg-green-500/10 border-green-500/20 text-green-100'}`}>
            {t.type === 'error' ? <AlertTriangle size={18} className="text-red-400" /> : <CheckCircle2 size={18} className="text-green-400" />}
            <p className="text-sm font-medium">{t.message}</p>
          </div>
        ))}
      </div>

      {/* Global Drag Overlay */}
      {isDragActive && (
        <div className="fixed inset-0 z-[200] bg-blue-900/40 backdrop-blur-md flex flex-col items-center justify-center animate-in fade-in duration-200">
          <div className="bg-slate-900/80 p-12 rounded-[3rem] border-4 border-dashed border-blue-400/50 flex flex-col items-center shadow-2xl transform scale-110">
            <div className="p-6 bg-blue-500/20 rounded-full mb-6">
              <UploadCloud size={64} className="text-blue-400 animate-bounce" />
            </div>
            <h2 className="text-4xl font-bold bg-gradient-to-r from-blue-200 to-white bg-clip-text text-transparent">Drop Files Here</h2>
            <p className="text-blue-300/70 mt-4 text-lg font-medium">Any format, original quality</p>
          </div>
        </div>
      )}

      {/* Glassy Header */}
      <header className="border-b border-white/5 bg-slate-950/60 backdrop-blur-xl sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-br from-blue-500/20 to-purple-500/20 p-2.5 rounded-2xl border border-white/5 shadow-inner">
              <Share2 size={24} className="text-blue-400" />
            </div>
            <h1 className="text-2xl font-extrabold bg-gradient-to-br from-white via-slate-200 to-slate-400 bg-clip-text text-transparent hidden sm:block tracking-tight">
              LocalShare X
            </h1>
          </div>

          <div className="flex items-center gap-4 bg-slate-900/80 px-5 py-2.5 rounded-full border border-white/10 shadow-lg backdrop-blur-md">
            <div className={`w-2.5 h-2.5 rounded-full animate-pulse shrink-0 shadow-[0_0_10px_currentColor] ${isConnected ? 'bg-green-500 text-green-500' : 'bg-red-500 text-red-500'}`} />
            <div className="flex flex-col items-start pr-2">
              {isEditingName ? (
                <input
                  autoFocus
                  type="text"
                  value={deviceName}
                  onChange={e => setDeviceName(e.target.value)}
                  onBlur={() => setIsEditingName(false)}
                  onKeyDown={e => { if (e.key === 'Enter') setIsEditingName(false) }}
                  className="bg-black/30 border border-blue-500/50 outline-none text-xs text-white px-2 py-1 rounded-md w-28 focus:ring-2 ring-blue-500/30 transition-all font-medium"
                />
              ) : (
                <span
                  className="text-sm font-semibold text-slate-200 cursor-pointer hover:text-white flex items-center gap-1.5 truncate max-w-[120px] sm:max-w-none transition-colors"
                  onClick={() => setIsEditingName(true)}
                  title="Click to change your device name"
                >
                  {deviceName} <Edit2 size={12} className="shrink-0 text-slate-500" />
                </span>
              )}
            </div>
            <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent mx-1 hidden sm:block" />
            <div className="flex items-center gap-2 hidden sm:flex bg-slate-950/50 px-3 py-1.5 rounded-lg border border-white/5">
              <ServerCog size={14} className="text-slate-400" />
              <input
                type="text"
                value={serverIp}
                onChange={e => setServerIp(e.target.value)}
                className="bg-transparent border-none outline-none text-xs w-28 text-slate-300 focus:text-white font-mono"
                title="Server IP Address"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-8 grid lg:grid-cols-12 gap-8 relative z-10">

        {/* Left Column */}
        <div className="lg:col-span-8 flex flex-col gap-8">

          {/* Incoming Requests Notification */}
          {incomingBatches.map((req, idx) => (
            <div key={idx} className="bg-gradient-to-r from-indigo-900/50 to-slate-900/50 border border-indigo-500/30 rounded-[2rem] p-5 flex flex-col sm:flex-row items-center justify-between gap-5 shadow-2xl animate-in fade-in zoom-in-95 duration-300">
              <div className="flex items-center gap-4 w-full sm:w-auto">
                <div className="bg-indigo-500/20 p-4 rounded-2xl text-indigo-300 shrink-0 relative overflow-hidden">
                  <div className="absolute inset-0 bg-indigo-400/20 animate-pulse" />
                  <Smartphone size={28} className="relative z-10" />
                </div>
                <div className="overflow-hidden">
                  <p className="text-lg font-bold text-white truncate">
                    {req.sender_name} wands to send files
                  </p>
                  <p className="text-sm text-indigo-200/70 truncate flex items-center gap-2 mt-0.5">
                    <span className="bg-indigo-500/20 px-2 py-0.5 rounded text-xs font-semibold">{req.files.length} Item{req.files.length > 1 ? 's' : ''}</span>
                    <span>{(req.files.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2)} MB</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 w-full sm:w-auto mt-2 sm:mt-0">
                <button onClick={() => handleIncomingResponse(req, false)} className="flex-1 sm:flex-none px-5 py-2.5 rounded-xl bg-slate-800/80 hover:bg-red-500/20 hover:text-red-400 text-slate-300 border border-transparent hover:border-red-500/30 transition-all font-medium">Reject</button>
                <button onClick={() => handleIncomingResponse(req, true)} className="flex-1 sm:flex-none px-6 py-2.5 rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white shadow-[0_0_20px_rgba(99,102,241,0.4)] transition-all font-bold flex items-center justify-center gap-2 transform hover:scale-105 active:scale-95"><ZapIcon size={18} fill="currentColor" /> Accept</button>
              </div>
            </div>
          ))}

          {/* Step 1: Network Selection */}
          <div className="bg-slate-900/40 rounded-[2rem] border border-white/5 p-6 md:p-8 backdrop-blur-2xl shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <h3 className="text-xl font-bold mb-6 text-slate-200 flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 rounded-lg text-blue-400"><Wifi size={20} /></div>
              1. Select Target Device
            </h3>
            {connectedDevices.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 px-4 bg-slate-950/30 rounded-[1.5rem] border border-dashed border-slate-800">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-4 border-slate-800 border-t-blue-500 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center"><Wifi size={20} className="text-slate-500" /></div>
                </div>
                <p className="mt-4 text-slate-400 font-medium text-center">Scanning local network for devices...</p>
                <p className="text-xs text-slate-600 mt-2 text-center max-w-xs">Make sure the other device has LocalShare X open to appear here.</p>
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-4 custom-scrollbar snap-x">
                {connectedDevices.map(dev => (
                  <button
                    key={dev.id}
                    onClick={() => toggleTarget(dev.id)}
                    className={`snap-center shrink-0 w-40 h-44 flex flex-col items-center justify-center gap-4 rounded-[1.5rem] border-2 transition-all transform active:scale-95 ${selectedTargets.includes(dev.id) ? 'border-blue-500 bg-gradient-to-b from-blue-500/10 to-transparent shadow-[0_0_20px_rgba(59,130,246,0.15)] ring-4 ring-blue-500/10' : 'border-slate-800 bg-slate-900/50 hover:border-slate-600 hover:bg-slate-800'}`}
                  >
                    <div className={`p-4 rounded-full transition-colors ${selectedTargets.includes(dev.id) ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-800 text-slate-400'}`}>
                      {dev.name.includes("Phone") || dev.name.includes("iOS") ? <Smartphone size={32} /> : <Monitor size={32} />}
                    </div>
                    <div className="text-center w-full px-3">
                      <p className={`font-bold text-sm truncate ${selectedTargets.includes(dev.id) ? 'text-blue-100' : 'text-slate-300'}`}>{dev.name}</p>
                      <div className="flex items-center justify-center gap-1.5 mt-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                        <p className="text-[10px] text-slate-500 font-medium">Ready</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Step 2: File Selection & Staging */}
          <div className="bg-slate-900/40 rounded-[2rem] border border-white/5 p-6 md:p-8 backdrop-blur-2xl shadow-xl relative overflow-hidden group">
            <h3 className="text-xl font-bold mb-6 text-slate-200 flex items-center gap-3">
              <div className="p-2 bg-purple-500/10 rounded-lg text-purple-400"><UploadCloud size={20} /></div>
              2. Add Files to Send
            </h3>

            <div
              onClick={() => fileInputRef.current?.click()}
              className="group/upload relative h-36 rounded-[1.5rem] border-2 border-dashed border-slate-700/50 bg-slate-900/40 hover:bg-slate-800/80 hover:border-purple-500/50 transition-all duration-300 flex flex-col items-center justify-center cursor-pointer overflow-hidden mb-6"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-purple-500/5 to-transparent opacity-0 group-hover/upload:opacity-100 transition-opacity duration-500" />
              <div className="bg-slate-950 p-4 rounded-full mb-3 shadow-lg group-hover/upload:scale-110 transition-transform duration-300 border border-white/5">
                <Plus size={24} className="text-purple-400" />
              </div>
              <span className="font-semibold text-slate-300 group-hover/upload:text-white transition-colors">Tap or drag files here</span>
              <span className="text-xs text-slate-500 mt-1">Preserved in Original Native Quality</span>
              <input type="file" multiple ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
            </div>

            {files.length > 0 && (
              <div className="bg-slate-950/60 rounded-[1.5rem] p-5 border border-slate-800/80 shadow-inner animate-in fade-in slide-in-from-bottom-4">
                <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-3">
                  <span className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <span className="bg-slate-800 px-2 py-1 rounded text-xs">{files.length}</span> Ready to send
                  </span>
                  <span className="text-xs font-mono text-slate-400 bg-slate-900 px-2 py-1 rounded">{(files.reduce((a, b) => a + b.size, 0) / 1024 / 1024).toFixed(2)} MB</span>
                </div>

                <div className="max-h-[220px] overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {files.map(file => (
                    <div key={file.file_id} className="flex items-center justify-between bg-slate-900/80 rounded-xl p-3 text-sm border border-white/5 hover:border-white/10 transition-colors group/item">
                      <div className="flex items-center gap-3 truncate">
                        <div className="w-8 h-8 rounded bg-slate-800 flex items-center justify-center shrink-0"><CheckCircle2 size={14} className="text-slate-500" /></div>
                        <span className="truncate pr-4 text-slate-300 font-medium">{file.name}</span>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); removeStagingFile(file.file_id); }} className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-red-500/10 hover:text-red-400 transition-colors shrink-0">
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  onClick={requestBatchTransfer}
                  disabled={selectedTargets.length === 0}
                  className={`w-full py-4 rounded-xl font-bold text-lg mt-5 transition-all shadow-xl flex justify-center items-center gap-3
                    ${selectedTargets.length > 0 ? 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-blue-500/25 hover:shadow-blue-500/40 transform hover:-translate-y-0.5' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
                >
                  <Share2 size={20} />
                  {selectedTargets.length > 0 ? `Send Batch to ${selectedTargets.length} Device(s)` : 'Select Target Device(s) Above'}
                </button>
              </div>
            )}
          </div>

          {/* Active Transfers */}
          {(Object.keys(activeBatches).length > 0 || Object.keys(receiveProgress).length > 0 || downloadables.length > 0) && (
            <div className="bg-slate-900/40 rounded-[2rem] border border-white/5 p-6 md:p-8 backdrop-blur-2xl shadow-xl animate-in fade-in slide-in-from-bottom-8">
              <h3 className="text-xl font-bold mb-6 text-slate-200 flex items-center gap-3">
                <div className="p-2 bg-green-500/10 rounded-lg text-green-400"><ZapIcon size={20} /></div>
                Live Transfers
              </h3>
              <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">

                {/* Sending Batches */}
                {Object.entries(activeBatches).map(([batchId, batch]) => {
                  const isWaiting = batch.status === 'waiting'
                  const isDone = batch.status === 'completed'
                  const totalMB = (batch.files.reduce((a, b) => a + b.size, 0) / 1024 / 1024).toFixed(2)

                  return (
                    <div key={batchId} className={`bg-slate-950/50 rounded-2xl p-5 border relative overflow-hidden transition-colors ${isDone ? 'border-green-500/20' : 'border-blue-500/20'}`}>
                      {isDone && <div className="absolute inset-0 bg-green-500/5 animate-in fade-in duration-1000" />}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-3 gap-3 relative z-10">
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-inner ${isDone ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
                            {isDone ? <CheckCircle2 size={24} /> : <UploadCloud size={24} className="animate-pulse" />}
                          </div>
                          <div className="overflow-hidden">
                            <p className="font-bold text-base truncate text-slate-200">Sending to {batch.target_name}</p>
                            <p className="text-sm text-slate-400 mt-0.5">{batch.files.length} files • {totalMB} MB total</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-end sm:self-auto ml-16 sm:ml-0">
                          {isDone ? (
                            <span className="text-green-400 font-bold flex items-center gap-1.5"><CheckCircle2 size={18} /> Success</span>
                          ) : isWaiting ? (
                            <span className="text-yellow-400 text-xs font-semibold px-3 py-1.5 bg-yellow-400/10 rounded-lg animate-pulse border border-yellow-400/20">Awaiting Accept...</span>
                          ) : (
                            <span className="text-blue-400 text-lg font-black">{batch.progress}%</span>
                          )}
                        </div>
                      </div>

                      {batch.status === 'uploading' && (
                        <div className="w-full bg-slate-900 rounded-full h-2 mt-4 overflow-hidden shadow-inner relative">
                          <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-400 rounded-full transition-all duration-300 relative" style={{ width: `${batch.progress}%` }}>
                            <div className="absolute top-0 bottom-0 right-0 w-20 bg-gradient-to-r from-transparent to-white/40 blur-sm translate-x-1/2" />
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Receiving Batches */}
                {Object.entries(receiveProgress).map(([batchId, progresses]) => {
                  const fileData = incomingBatches.find(x => x.batch_id === batchId)
                  if (!fileData) return null

                  let totalPercents = 0
                  let filesCount = fileData.files.length
                  let isDone = true

                  fileData.files.forEach(f => {
                    const p = progresses[f.file_id] || 0
                    totalPercents += p
                    if (p < 100) isDone = false
                  })

                  const avgProgress = Math.floor(totalPercents / filesCount)
                  return (
                    <div key={batchId} className="bg-slate-950/50 rounded-2xl p-5 border border-indigo-500/30 relative overflow-hidden shadow-lg">
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between z-10 relative gap-3">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-xl bg-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0 border border-indigo-500/20">
                            <ZapIcon size={24} fill="currentColor" className="animate-pulse opacity-80" />
                          </div>
                          <div>
                            <p className="font-bold text-base truncate text-slate-200">↓ Receiving {filesCount} file{filesCount > 1 ? 's' : ''}</p>
                            <p className="text-sm text-slate-400 mt-0.5">From {fileData.sender_name}</p>
                          </div>
                        </div>
                        <div className="text-lg font-black text-indigo-400 self-end sm:self-auto ml-16 sm:ml-0 bg-indigo-500/10 px-3 py-1 rounded-lg">
                          {avgProgress}%
                        </div>
                      </div>
                      <div className="w-full bg-slate-900 rounded-full h-2 mt-4 overflow-hidden z-10 relative shadow-inner">
                        <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-300 relative" style={{ width: `${avgProgress}%` }}>
                          <div className="absolute top-0 bottom-0 right-0 w-20 bg-gradient-to-r from-transparent to-white/40 blur-sm translate-x-1/2" />
                        </div>
                      </div>
                    </div>
                  )
                })}

                {/* Downloadables (Finished receiving) */}
                {downloadables.map((data, i) => (
                  <div key={`dl-${i}`} className="bg-green-950/30 rounded-2xl p-5 border border-green-500/30 relative overflow-hidden shadow-lg animate-in fade-in slide-in-from-top-4">
                    <div className="absolute inset-0 bg-green-500/5 z-0" />
                    <div className="flex items-center justify-between z-10 relative gap-3">
                      <div className="flex items-center gap-4 w-full">
                        <div className="w-12 h-12 rounded-xl bg-green-500/20 flex items-center justify-center text-green-400 shrink-0 shadow-[0_0_15px_rgba(34,197,94,0.2)]">
                          <CheckCircle2 size={24} />
                        </div>
                        <div className="overflow-hidden flex-1">
                          <p className="font-bold text-base truncate text-green-100 flex items-center gap-2">Ready <ZapIcon size={14} fill="currentColor" className="text-yellow-400" /></p>
                          <p className="text-sm text-green-400/80 truncate">{data.filename}</p>
                        </div>
                        <button onClick={() => triggerDownload(data.download_url, data.filename)} className="ml-auto px-4 py-2 bg-green-500 hover:bg-green-400 text-slate-950 font-bold rounded-lg text-sm shrink-0 shadow-lg transition-colors">
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

              </div>
            </div>
          )}
        </div>

        {/* Right Column (Info Sidebar) */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          <div className="bg-slate-900/40 rounded-[2rem] border border-white/5 p-7 sticky top-28 backdrop-blur-2xl shadow-xl">
            <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-3">
              <div className="p-2 bg-indigo-500/20 rounded-lg text-indigo-400"><Info size={20} /></div>
              Platform Core
            </h3>

            <div className="space-y-6">
              <div className="group flex items-start gap-4 p-3 -m-3 hover:bg-slate-800/50 rounded-xl transition-colors">
                <div className="bg-gradient-to-br from-blue-500/20 to-blue-600/20 p-2.5 rounded-xl text-blue-400 shrink-0 shadow-inner group-hover:scale-110 transition-transform"><CheckCircle2 size={18} /></div>
                <div>
                  <strong className="block text-slate-200 mb-1 font-semibold text-sm">Turbo LAN Transfer</strong>
                  <p className="text-xs text-slate-400 leading-relaxed">Images and massive videos are channeled locally via 10MB ultra-fast bursts.</p>
                </div>
              </div>

              <div className="group flex items-start gap-4 p-3 -m-3 hover:bg-slate-800/50 rounded-xl transition-colors">
                <div className="bg-gradient-to-br from-purple-500/20 to-purple-600/20 p-2.5 rounded-xl text-purple-400 shrink-0 shadow-inner group-hover:scale-110 transition-transform"><ShieldAlert size={18} /></div>
                <div>
                  <strong className="block text-slate-200 mb-1 font-semibold text-sm">Zero Trace Security</strong>
                  <p className="text-xs text-slate-400 leading-relaxed">Files self-destruct from the server explicitly after delivery to conserve absolute storage bounds.</p>
                </div>
              </div>

              <div className="group flex items-start gap-4 p-3 -m-3 hover:bg-slate-800/50 rounded-xl transition-colors">
                <div className="bg-gradient-to-br from-green-500/20 to-green-600/20 p-2.5 rounded-xl text-green-400 shrink-0 shadow-inner group-hover:scale-110 transition-transform"><UploadCloud size={18} /></div>
                <div>
                  <strong className="block text-slate-200 mb-1 font-semibold text-sm">Smart Drag & Drop</strong>
                  <p className="text-xs text-slate-400 leading-relaxed">Throw files anywhere onto the screen space at any time to instantly queue them into staging.</p>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-white/5">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>LocalShare X Build</span>
                <span className="bg-slate-800 px-2 py-1 rounded text-slate-400 border border-slate-700">v2.1 Pro</span>
              </div>
               <div className="mt-8 pt-6 border-t border-white/5">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>The programmer</span>
                <span className="bg-slate-800 px-2 py-1 rounded text-slate-400 border border-slate-700">obada</span>
              </div>
            </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
