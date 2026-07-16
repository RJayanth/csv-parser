// CustomFileViewer.tsx
import {
  useState,
  useEffect,
  useRef,
  type ChangeEvent,
  type CSSProperties,
} from 'react';

import ParseWorker from '../../parser.worker.js?worker';
import VirtualList from '../../commons/VirtualList';


type Mode = 'traditional' | 'optimized';
type ParsedRow = string[];

type WorkerMessageData =
  | { type: 'STATUS'; message: string }
  | { type: 'PROGRESS'; totalSoFar: number; message?: string }
  | { type: 'DONE'; totalRows: number }
  | { type: 'ERROR'; error: string };

const MAX_CACHED_ROWS = 250;

export default function CustomFileViewer() {
  const [rowCount, setRowCount] = useState(0);
  const [status, setStatus] = useState('');
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>('optimized');
  const [fileDetails, setFileDetails] = useState<{ name: string; size: string } | null>(null);
  const [parseDuration, setParseDuration] = useState<string | null>(null);
  const [, setCacheVersion] = useState(0);
  
  const startTimeRef = useRef<number | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const rowCacheRef = useRef<Record<number, ParsedRow>>({});
  const dbRef = useRef<IDBDatabase | null>(null);
  const fileRef = useRef<File | null>(null);
  const dragOverRef = useRef<boolean>(false);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      dbRef.current?.close();
    };
  }, []);

  const resetState = () => {
    setRowCount(0);
    setStatus('');
    setProgressPercent(null);
    setParseDuration(null);
    setFileDetails(null);
    setCacheVersion(0);
    rowCacheRef.current = {};
    workerRef.current?.terminate();
    workerRef.current = null;
    dbRef.current?.close();
    dbRef.current = null;
  };

  const ensureDatabase = () => {
    if (dbRef.current) {
      return Promise.resolve(dbRef.current);
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('LargeCSVDatabase', 2);

      request.onupgradeneeded = (e) => {
        const database = request.result;
        if (!database.objectStoreNames.contains('blocks')) {
          database.createObjectStore('blocks', { keyPath: 'blockIndex' });
        }
      };

      request.onsuccess = () => {
        dbRef.current = request.result;
        resolve(request.result);
      };

      request.onerror = () => reject(request.error);
    });
  };

  const ROWS_PER_BLOCK = 5000;

  const fetchRowsForRange = async (startIndex: number, endIndex: number) => {
    if (rowCount <= 0 || !fileRef.current) return;

    const safeStart = Math.max(0, startIndex);
    const safeEnd = Math.min(Math.max(0, endIndex), rowCount - 1);

    if (safeEnd < safeStart) return;

    const targetBlockIndex = Math.floor(safeStart / ROWS_PER_BLOCK);

    const database = await ensureDatabase();
    const transaction = database.transaction('blocks', 'readonly');
    const store = transaction.objectStore('blocks');

    const request = store.get(targetBlockIndex);

    request.onsuccess = async () => {
      const blockMeta = request.result;
      if (!blockMeta) return;

      const decoder = new TextDecoder('utf-8');

      try {
        const slice = fileRef.current!.slice(
          blockMeta.startByte,
          blockMeta.endByte,
        );
        const buffer = await slice.arrayBuffer();
        const textBlock = decoder.decode(buffer);

        const lines = textBlock.split(/\r?\n/);
        const nextRows: Record<number, ParsedRow> = {};

        lines.forEach((line, index) => {
          const actualRowIndex = blockMeta.startRow + index;
          if (
            line.trim() !== '' &&
            actualRowIndex <= safeEnd &&
            actualRowIndex >= safeStart
          ) {
            nextRows[actualRowIndex] = line.split(',');
          }
        });

        const mergedCache = { ...rowCacheRef.current, ...nextRows };
        const trimmedCache: Record<number, ParsedRow> = {};

        Object.entries(mergedCache).forEach(([idxStr, row]) => {
          const idx = Number(idxStr);
          if (idx >= safeStart - 200 && idx <= safeEnd + 200) {
            trimmedCache[idx] = row;
          }
        });

        rowCacheRef.current = trimmedCache;
        setCacheVersion((current) => current + 1);
      } catch (err) {
        console.error('Failed to slice block:', err);
      }
    };
  };

  const handleModeChange = () => {
    const newMode = mode === 'optimized' ? 'traditional' : 'optimized';
    resetState();
    setMode(newMode);
  };

  const loadVisibleRows = async (startIndex: number, endIndex: number) => {
    let cacheMissing = false;
    for (let i = startIndex; i <= endIndex; i++) {
      if (!rowCacheRef.current[i]) {
        cacheMissing = true;
        break;
      }
    }

    if (!cacheMissing) return;
    await fetchRowsForRange(startIndex, endIndex);
  };

  const processSelectedFile = (file: File) => {
    fileRef.current = file;
    const sizeInMb = file.size / (1024 * 1024);
    
    setFileDetails({
      name: file.name,
      size: sizeInMb > 1024 ? `${(sizeInMb / 1024).toFixed(2)} GB` : `${sizeInMb.toFixed(2)} MB`
    });

    setStatus('Reading file schema...');
    setRowCount(0);
    setCacheVersion(0);
    rowCacheRef.current = {};

    if (mode === 'traditional') {
      if (sizeInMb > 50) {
        setStatus(
          `Traditional mode struggles with files over 50MB. Please switch to Optimized mode.`
        );
        return;
      }

      const reader = new FileReader();
      const start = performance.now();
      reader.onload = (e) => {
        const text = e.target?.result;
        if (typeof text !== 'string') return;

        const rows = text.split('\n').map((line) => line.split(','));
        const end = performance.now();
        setParseDuration(((end - start) / 1000).toFixed(2));
        setRowCount(rows.length);
        setStatus('Ready');
      };
      reader.readAsText(file);
      return;
    }

    const start = (startTimeRef.current = performance.now());

    workerRef.current?.terminate();
    workerRef.current = new ParseWorker();

    workerRef.current.onmessage = (event: MessageEvent<WorkerMessageData>) => {
      const { type } = event.data;

      if (type === 'STATUS') {
        setStatus(event.data.message);
      } else if (type === 'PROGRESS') {
        setRowCount(event.data.totalSoFar);
        
        // Extract progress percentage from message string (e.g., "Mapping blocks... 25.1%")
        const msg = event.data.message || '';
        const match = msg.match(/(\d+\.?\d*)%/);
        if (match) {
          setProgressPercent(parseFloat(match[1]));
        }
        setStatus(msg || `Parsed ${event.data.totalSoFar.toLocaleString()} rows`);
      } else if (type === 'DONE') {
        const end = performance.now();
        const duration = ((end - start) / 1000).toFixed(2);
        setParseDuration(duration);
        setRowCount(event.data.totalRows);
        setProgressPercent(100);
        setStatus('Ready');

        void fetchRowsForRange(0, 15);
      } else if (type === 'ERROR') {
        setStatus(`Error: ${event.data.error}`);
        setProgressPercent(null);
      }
    };

    workerRef.current.postMessage({ file });
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) processSelectedFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.endsWith('.csv')) {
      processSelectedFile(file);
    }
  };

  const Row = ({ index, style }: { index: number; style: CSSProperties }) => {
    const row = rowCacheRef.current[index];

    return (
      <div
        style={style}
        className={`flex items-center border-b border-slate-100 px-6 text-sm font-mono transition-colors hover:bg-slate-50/80 ${
          index % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'
        }`}
      >
        <div className="mr-6 w-16 select-none font-sans text-xs font-semibold text-slate-400">
          {(index + 1).toLocaleString()}
        </div>
        <div className="flex-1 truncate text-slate-700 whitespace-nowrap">
          {row ? (
            row.map((cell, cellIdx) => (
              <span key={cellIdx} className="inline-block mr-4 last:mr-0">
                <span className="bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 mr-1 select-none text-[10px] uppercase font-sans font-bold">
                  Col {cellIdx + 1}
                </span>
                <span className="text-slate-800">{cell || <span className="text-slate-300">null</span>}</span>
              </span>
            ))
          ) : (
            <span className="text-slate-300 italic animate-pulse">Loading block content...</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-5xl p-8 text-slate-800 font-sans">
      {/* ── HEADER ── */}
      <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 flex items-center gap-2">
            Superbolt <span className="text-blue-600 text-2xl font-light">CSV Engine v2</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Engineered to map, slice, and stream multi-gigabyte datasets directly inside browser sandbox.
          </p>
        </div>

        {/* Mode Toggle Swtich */}
        <div className="flex items-center gap-3 bg-slate-100 p-1.5 rounded-full border border-slate-200 self-start md:self-auto">
          <button
            onClick={() => { if (mode !== 'traditional') handleModeChange(); }}
            className={`px-4 py-1.5 text-xs font-bold rounded-full transition-all ${
              mode === 'traditional'
                ? 'bg-white text-slate-950 shadow-sm'
                : 'text-slate-500 hover:text-slate-950'
            }`}
          >
            Traditional
          </button>
          <button
            onClick={() => { if (mode !== 'optimized') handleModeChange(); }}
            className={`px-4 py-1.5 text-xs font-bold rounded-full transition-all flex items-center gap-1.5 ${
              mode === 'optimized'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-950'
            }`}
          >
            Optimized
            <span className="bg-blue-500 text-[9px] text-blue-100 px-1 py-0.2 rounded font-black">ACTIVE</span>
          </button>
        </div>
      </div>

      {/* ── DRAG & DROP ZONE ── */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`group relative mb-8 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
          isDragOver
            ? 'border-blue-500 bg-blue-50/50 scale-[0.99]'
            : 'border-slate-300 hover:border-slate-400 bg-white hover:bg-slate-50/30'
        }`}
      >
        <input
          id="csv-file-picker"
          type="file"
          accept=".csv"
          onChange={handleFileUpload}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
        <div className="mb-4 rounded-full bg-slate-50 p-4 border border-slate-100 group-hover:scale-105 transition-transform">
          <svg className="h-8 w-8 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V4a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
        </div>
        <h3 className="text-md font-bold text-slate-800">
          {fileDetails ? fileDetails.name : 'Drag & drop your CSV file here'}
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          {fileDetails ? `Detected: ${fileDetails.size}` : 'Or click to browse your storage. Handles files up to 10GB.'}
        </p>
      </div>

      {/* ── METRICS DASHBOARD ── */}
      {fileDetails && (
        <div className="mb-8 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Indexed Rows</span>
            <span className="text-xl font-black text-slate-900 mt-1 block">
              {rowCount > 0 ? rowCount.toLocaleString() : '---'}
            </span>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Physical File Size</span>
            <span className="text-xl font-black text-slate-900 mt-1 block">
              {fileDetails.size}
            </span>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Processing Time</span>
            <span className="text-xl font-black text-blue-600 mt-1 block">
              {parseDuration ? `${parseDuration}s` : 'Counting...'}
            </span>
          </div>

          <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Engine Status</span>
            <span className="text-xs font-bold mt-1.5 flex items-center gap-1.5 text-slate-600 block">
              <span className={`h-2.5 w-2.5 rounded-full ${status === 'Ready' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-400 animate-spin'}`} />
              {status}
            </span>
          </div>
        </div>
      )}

      {/* ── PROGRESS BAR ── */}
      {progressPercent !== null && progressPercent < 100 && (
        <div className="mb-8 bg-slate-100 p-4 rounded-xl border border-slate-200">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">Mapping Blocks Schema</span>
            <span className="text-xs font-black text-blue-600">{progressPercent}%</span>
          </div>
          <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-150 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {/* ── EMPTY DEFAULT VIEW ── */}
      {!fileDetails && (
        <div className="text-center py-20 bg-slate-50/50 rounded-2xl border border-slate-100">
          <p className="text-slate-400 text-sm">Please upload or drag a structured CSV file to initiate mapping.</p>
        </div>
      )}

      {/* ── HIGH PERFORMANCE DATA GRID ── */}
      {mode === 'optimized' && fileDetails && rowCount > 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          {/* Grid Header Panel */}
          <div className="bg-slate-50 border-b border-slate-200 px-6 py-3 flex justify-between items-center text-xs font-bold text-slate-500 uppercase tracking-wider">
            <span>Dynamic Column Schema Mapper</span>
            <span className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded font-black normal-case">Sliding Window: 500px Viewport</span>
          </div>
          
          <VirtualList
            height={500}
            itemCount={rowCount}
            itemSize={40}
            overscanCount={12}
            onItemsRendered={({ visibleStartIndex, visibleStopIndex }) => {
              void loadVisibleRows(visibleStartIndex, visibleStopIndex);
            }}
          >
            {Row}
          </VirtualList>
        </div>
      ) : null}
    </div>
  );
}