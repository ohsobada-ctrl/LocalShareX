import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { UploadCloud, CheckCircle2, Shield, Share2, ServerCog, Wifi, Smartphone, Monitor, ShieldAlert, ZapIcon, Edit2, X, Plus } from 'lucide-react'

const DEFAULT_HOST = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname
const PORT = 8000
const CHUNK_SIZE = 1024 * 1024 // 1MB

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
            setIncomingBatches(prev => [...prev, data])
            break;
          case 'batch_response_result':
            if (data.accepted) {
              const batch = activeBatchesRef.current[data.batch_id]
              if (batch) startUploadingBatch(data.batch_id, batch.files, batch.target_id)
            } else {
              alert("Target device rejected the transfer.")
              setActiveBatches(prev => {
                const next = { ...prev }
                delete next[data.batch_id]
                return next
              })
            }
            break;
          case 'batch_error':
            alert(data.error || "Failed to contact target device.")
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

  const handleDrop = (e) => {
    e.preventDefault()
    if (e.dataTransfer.files?.length > 0) appendFiles(e.dataTransfer.files)
  }

  const handleFileSelect = (e) => {
    if (e.target.files?.length > 0) appendFiles(e.target.files)
  }

  const appendFiles = (newFiles) => {
    const fileArray = Array.from(newFiles).map(f => {
      f.file_id = `${f.name}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
      return f
    })
    setFiles(prev => [...prev, ...fileArray])
    // Reset file input so same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const removeStagingFile = (file_id) => {
    setFiles(prev => prev.filter(f => f.file_id !== file_id))
  }

  const requestBatchTransfer = () => {
    if (selectedTargets.length === 0) return alert("Please select at least one target device first!")
    if (files.length === 0) return alert("Please add files first!")

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
        }).catch(err => console.error("Chunk upload failed", err))

        uploadPromises.push(request)
        if (uploadPromises.length >= 5) {
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
      }).catch(err => console.error("Finalize failed", err))
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
    a.target = '_blank'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-blue-500/30">
      <header className="border-b border-white/10 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-blue-500/20 p-2 rounded-xl text-blue-400">
              <Share2 size={24} />
            </div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent hidden sm:block">
              LocalShare X
            </h1>
          </div>

          <div className="flex items-center gap-4 bg-slate-900 px-4 py-2 rounded-full border border-white/10">
            <div className={`w-2 h-2 rounded-full animate-pulse shrink-0 ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <div className="flex flex-col items-start pr-2">
              {isEditingName ? (
                <input
                  autoFocus
                  type="text"
                  value={deviceName}
                  onChange={e => setDeviceName(e.target.value)}
                  onBlur={() => setIsEditingName(false)}
                  onKeyDown={e => { if (e.key === 'Enter') setIsEditingName(false) }}
                  className="bg-black/20 border border-white/10 outline-none text-xs text-white px-1 py-0.5 rounded w-24"
                />
              ) : (
                <span
                  className="text-xs font-semibold text-slate-200 cursor-pointer hover:text-white flex items-center gap-1 truncate max-w-[100px] sm:max-w-none"
                  onClick={() => setIsEditingName(true)}
                  title="Click to change your device name"
                >
                  {deviceName} <Edit2 size={10} className="shrink-0" />
                </span>
              )}
              {isConnected ? <span className="text-[10px] text-green-400">Online</span> : <span className="text-[10px] text-red-400">Connecting...</span>}
            </div>
            <div className="w-px h-6 bg-white/10 mx-2 hidden sm:block" />
            <div className="flex items-center gap-2 hidden sm:flex">
              <ServerCog size={16} className="text-slate-400" />
              <input
                type="text"
                value={serverIp}
                onChange={e => setServerIp(e.target.value)}
                className="bg-transparent border-none outline-none text-sm w-32 text-slate-300 focus:text-white"
                placeholder="Server IP"
              />
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-8 grid lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 flex flex-col gap-6">

          {/* Incoming Requests */}
          {incomingBatches.map((req, idx) => (
            <div key={idx} className="bg-indigo-900/40 border border-indigo-500/50 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4">
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <div className="bg-indigo-500/20 p-3 rounded-full text-indigo-300 shrink-0">
                  <Smartphone size={24} />
                </div>
                <div className="overflow-hidden">
                  <p className="font-semibold text-slate-200 truncate">
                    {req.sender_name} sent you {req.files.length} file{req.files.length > 1 ? 's' : ''}
                  </p>
                  <p className="text-sm text-indigo-200/70 truncate">
                    {req.files.length === 1 ? req.files[0].name : 'Group of files'} <span className="mx-2">•</span>
                    {(req.files.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto mt-2 sm:mt-0">
                <button onClick={() => handleIncomingResponse(req, false)} className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors">Reject</button>
                <button onClick={() => handleIncomingResponse(req, true)} className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white shadow-lg transition-colors font-medium flex items-center justify-center gap-2"><ZapIcon size={16} /> Accept</button>
              </div>
            </div>
          ))}

          {/* Network Selection */}
          <div className="bg-slate-900/50 rounded-3xl border border-white/10 p-6 backdrop-blur-sm">
            <h3 className="text-lg font-semibold mb-4 text-slate-200 flex items-center gap-2">
              <Wifi size={20} className="text-blue-400" />
              1. Select Target Device
            </h3>
            {connectedDevices.length === 0 ? (
              <div className="text-center py-8 text-slate-500 bg-slate-950/50 rounded-2xl border border-dashed border-slate-800">
                Waiting for others to join {serverIp}...
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-4 custom-scrollbar snap-x">
                {connectedDevices.map(dev => (
                  <button
                    key={dev.id}
                    onClick={() => toggleTarget(dev.id)}
                    className={`snap-center shrink-0 w-36 h-36 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 transition-all ${selectedTargets.includes(dev.id) ? 'border-blue-500 bg-blue-500/10' : 'border-slate-800 bg-slate-800/30 hover:border-slate-600'}`}
                  >
                    <div className={selectedTargets.includes(dev.id) ? 'text-blue-400' : 'text-slate-400'}>
                      {dev.name.includes("Phone") || dev.name.includes("iOS") ? <Smartphone size={40} /> : <Monitor size={40} />}
                    </div>
                    <div className="text-center w-full px-2">
                      <p className={`font-medium text-sm truncate ${selectedTargets.includes(dev.id) ? 'text-blue-200' : 'text-slate-300'}`}>{dev.name}</p>
                      <p className="text-[10px] text-slate-500 uppercase mt-1 px-2 py-0.5 bg-black/20 rounded-full inline-block">Online</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* File Selection & Staging */}
          <div className="bg-slate-900/50 rounded-3xl border border-white/10 p-6 backdrop-blur-sm">
            <h3 className="text-lg font-semibold mb-4 text-slate-200 flex items-center gap-2">
              <UploadCloud size={20} className="text-blue-400" />
              2. Add Files to Send
            </h3>

            <div
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="group relative h-32 rounded-2xl border-2 border-dashed border-slate-700/50 bg-slate-900/50 hover:bg-slate-800/50 hover:border-blue-500/50 transition-all duration-300 flex flex-col items-center justify-center cursor-pointer overflow-hidden mb-4"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="flex items-center gap-3 text-slate-400 group-hover:text-blue-400 transition-colors">
                <Plus size={24} />
                <span className="font-medium">Tap or drop files here (Full Quality)</span>
              </div>
              <input type="file" multiple ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
            </div>

            {files.length > 0 && (
              <div className="bg-slate-950/50 rounded-2xl p-4 border border-slate-800 space-y-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-slate-300">{files.length} file{files.length > 1 ? 's' : ''} ready</span>
                  <span className="text-xs text-slate-500">{(files.reduce((a, b) => a + b.size, 0) / 1024 / 1024).toFixed(2)} MB total</span>
                </div>

                <div className="max-h-[200px] overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {files.map(file => (
                    <div key={file.file_id} className="flex items-center justify-between bg-slate-900 rounded-xl p-3 text-sm border border-white/5">
                      <span className="truncate pr-4 text-slate-300">{file.name}</span>
                      <button onClick={(e) => { e.stopPropagation(); removeStagingFile(file.file_id); }} className="text-slate-500 hover:text-red-400 transition-colors shrink-0">
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  onClick={requestBatchTransfer}
                  disabled={selectedTargets.length === 0}
                  className={`w-full py-4 rounded-xl font-bold text-lg mt-2 transition-all shadow-lg flex justify-center items-center gap-2
                    ${selectedTargets.length > 0 ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/20' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
                >
                  <Share2 size={20} />
                  {selectedTargets.length > 0 ? `Send Batch to ${selectedTargets.length} Device(s)` : 'Select Target Device(s) Above'}
                </button>
              </div>
            )}
          </div>

          {/* Active Transfers */}
          {(Object.keys(activeBatches).length > 0 || Object.keys(receiveProgress).length > 0 || downloadables.length > 0) && (
            <div className="bg-slate-900/50 rounded-3xl border border-white/10 p-6">
              <h3 className="text-lg font-semibold mb-4 text-slate-200">Active Transfers</h3>
              <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">

                {/* Sending Batches */}
                {Object.entries(activeBatches).map(([batchId, batch]) => {
                  const isWaiting = batch.status === 'waiting'
                  const isDone = batch.status === 'completed'
                  const totalMB = (batch.files.reduce((a, b) => a + b.size, 0) / 1024 / 1024).toFixed(2)

                  return (
                    <div key={batchId} className="bg-slate-800/50 rounded-2xl p-4 border border-white/5 relative overflow-hidden">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-2 gap-2">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                            <UploadCloud size={20} />
                          </div>
                          <div className="overflow-hidden">
                            <p className="font-medium text-sm truncate">Sending to {batch.target_name}</p>
                            <p className="text-xs text-slate-400">{batch.files.length} files • {totalMB} MB total</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 self-start sm:self-auto ml-12 sm:ml-0">
                          {isDone ? (
                            <span className="text-green-400 flex items-center gap-1 text-sm"><CheckCircle2 size={16} /> Completed</span>
                          ) : isWaiting ? (
                            <span className="text-yellow-400 text-xs px-2 py-1 bg-yellow-400/10 rounded-lg">Waiting for Accept...</span>
                          ) : (
                            <span className="text-blue-400 text-sm font-semibold">{batch.progress}%</span>
                          )}
                        </div>
                      </div>

                      {batch.status === 'uploading' && (
                        <div className="w-full bg-slate-950 rounded-full h-1.5 mt-3 overflow-hidden">
                          <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${batch.progress}%` }} />
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
                  // Notice: When backend sends 'batch_complete', we handle that and put into downloadables.
                  // So we only show here while receiving.
                  return (
                    <div key={batchId} className="bg-slate-800/50 rounded-2xl p-4 border border-indigo-500/20 relative overflow-hidden">
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between z-10 relative gap-2">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 shrink-0 animate-pulse">
                            <ZapIcon size={20} />
                          </div>
                          <div>
                            <p className="font-medium text-sm truncate">↓ Receiving {filesCount} file{filesCount > 1 ? 's' : ''}</p>
                            <p className="text-xs text-slate-400">From {fileData.sender_name}</p>
                          </div>
                        </div>
                        <div className="text-sm font-semibold text-indigo-400 self-start sm:self-auto ml-12 sm:ml-0">
                          {avgProgress}%
                        </div>
                      </div>
                      <div className="w-full bg-slate-950 rounded-full h-1.5 mt-3 overflow-hidden z-10 relative">
                        <div className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${avgProgress}%` }} />
                      </div>
                    </div>
                  )
                })}

                {/* Downloadables (Finished receiving) */}
                {downloadables.map((data, i) => (
                  <div key={`dl-${i}`} className="bg-slate-800/50 rounded-2xl p-4 border border-green-500/20 relative overflow-hidden">
                    <div className="absolute inset-0 bg-green-500/5 z-0" />
                    <div className="flex items-center justify-between z-10 relative gap-2">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center text-green-400 shrink-0">
                          <CheckCircle2 size={20} />
                        </div>
                        <div className="overflow-hidden flex-1">
                          <p className="font-medium text-sm truncate text-green-100">Saved: {data.filename}</p>
                          <button onClick={() => triggerDownload(data.download_url, data.filename)} className="text-xs text-green-400 hover:text-green-300 underline mt-1 text-left block">
                            Download Again
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-4 flex flex-col gap-6">
          <div className="bg-gradient-to-br from-indigo-500/10 to-purple-500/10 rounded-3xl border border-indigo-500/20 p-6 sticky top-24">
            <h3 className="text-lg font-semibold text-indigo-300 mb-4 flex items-center gap-2">
              <Shield size={20} /> App Info
            </h3>
            <ul className="space-y-4 text-sm text-slate-300">
              <li className="flex items-start gap-3">
                <div className="bg-slate-900 p-1.5 rounded-lg text-blue-400 shrink-0"><CheckCircle2 size={16} /></div>
                <div>
                  <strong className="block text-white">Full Quality Transfer</strong>
                  Images and videos are sent byte-by-byte with exactly 0% compression.
                </div>
              </li>
              <li className="flex items-start gap-3">
                <div className="bg-slate-900 p-1.5 rounded-lg text-purple-400 shrink-0"><ZapIcon size={16} /></div>
                <div>
                  <strong className="block text-white">Batch Sending</strong>
                  Select multiple files and send them all at once. They will be zipped automatically.
                </div>
              </li>
              <li className="flex items-start gap-3">
                <div className="bg-slate-900 p-1.5 rounded-lg text-green-400 shrink-0"><Edit2 size={16} /></div>
                <div>
                  <strong className="block text-white">Custom Device Name</strong>
                  Tap your device name at the top to customize how others see you on the network.
                </div>
              </li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  )
}

export default App
