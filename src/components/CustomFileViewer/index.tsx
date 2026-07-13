import {
  useState,
  useEffect,
  useRef,
  type ChangeEvent,
  type CSSProperties,
} from 'react';
import { List } from 'react-window';

import ParseWorker from '../../parser.worker.js?worker';

type Mode = 'traditional' | 'optimized';
type ParsedRow = string[];

type WorkerMessageData =
  | { type: 'STATUS'; message: string }
  | { type: 'PROGRESS'; totalSoFar: number }
  | { type: 'DONE'; totalRows: number }
  | { type: 'ERROR'; error: string };

const MAX_CACHED_ROWS = 120;

export default function CustomFileViewer() {
  const [rowCount, setRowCount] = useState(0);
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState<Mode>('traditional');
  const [, setCacheVersion] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const rowCacheRef = useRef<Record<number, ParsedRow>>({});
  const dbRef = useRef<IDBDatabase | null>(null);
  const loadingRangeRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      dbRef.current?.close();
    };
  }, []);

  const resetState = () => {
    setRowCount(0);
    setStatus('');
    setCacheVersion(0);
    rowCacheRef.current = {};
    loadingRangeRef.current = null;
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
      const request = indexedDB.open('LargeCSVDatabase', 1);

      request.onsuccess = () => {
        dbRef.current = request.result;
        resolve(request.result);
      };

      request.onerror = () => reject(request.error);
    });
  };

  const fetchRowsForRange = async (startIndex: number, endIndex: number) => {
    if (rowCount <= 0) return;

    const safeStart = Math.max(0, startIndex);
    const safeEnd = Math.min(Math.max(0, endIndex), rowCount - 1);

    if (safeEnd < safeStart) return;

    const database = await ensureDatabase();
    const transaction = database.transaction('rows', 'readonly');
    const store = transaction.objectStore('rows');

    await new Promise<void>((resolve, reject) => {
      const request = store.getAll(
        IDBKeyRange.bound(safeStart, safeEnd, false, false),
      );

      request.onsuccess = () => {
        const rows = request.result ?? [];
        const nextRows: Record<number, ParsedRow> = {};

        rows.forEach((rowEntry, index) => {
          const rowIndex = safeStart + index;
          if (rowEntry?.data) {
            nextRows[rowIndex] = rowEntry.data;
          }
        });

        const mergedCache = { ...rowCacheRef.current, ...nextRows };
        const entries = Object.entries(mergedCache).sort(
          ([left], [right]) => Number(left) - Number(right),
        );
        const trimmedEntries = entries.slice(-MAX_CACHED_ROWS);

        const trimmedCache: Record<number, ParsedRow> = {};
        trimmedEntries.forEach(([index, row]) => {
          trimmedCache[Number(index)] = row;
        });

        rowCacheRef.current = trimmedCache;
        setCacheVersion((current) => current + 1);
        resolve();
      };

      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  };

  const handleModeChange = () => {
    const newMode = mode === 'optimized' ? 'traditional' : 'optimized';
    resetState();
    setMode(newMode);
  };

  const loadVisibleRows = async (startIndex: number, endIndex: number) => {
    const sameRange =
      loadingRangeRef.current?.start === startIndex &&
      loadingRangeRef.current?.end === endIndex;

    if (sameRange) return;

    loadingRangeRef.current = { start: startIndex, end: endIndex };
    await fetchRowsForRange(startIndex, endIndex);
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus('Processing...');
    setRowCount(0);
    setCacheVersion(0);
    rowCacheRef.current = {};
    loadingRangeRef.current = null;

    if (mode === 'traditional') {
      const sizeInMb = file.size / (1024 * 1024);

      if (sizeInMb > 50) {
        setStatus(
          `Traditional mode may struggle with ${file.name} (${sizeInMb.toFixed(1)} MB). It loads the entire file into memory and can fail. Switch to Optimized mode for chunked processing.`,
        );
        return;
      }

      const reader = new FileReader();

      reader.onload = (e) => {
        const text = e.target?.result;
        if (typeof text !== 'string') return;

        const rows = text.split('\n').map((line) => line.split(','));
        setRowCount(rows.length);
        setStatus(`Finished! Total rows: ${rows.length}`);
      };

      reader.onerror = () => {
        setStatus(
          `Traditional mode could not read ${file.name}. Large CSVs can exceed browser memory limits. Switch to Optimized mode for better handling.`,
        );
      };

      reader.readAsText(file);
      return;
    }
    const start = startTimeRef.current = performance.now();

    workerRef.current?.terminate();
    workerRef.current = new ParseWorker();

    workerRef.current.onmessage = (event: MessageEvent<WorkerMessageData>) => {
      const { type } = event.data;

      if (type === 'STATUS') {
        setStatus(event.data.message);
      } else if (type === 'PROGRESS') {
        setRowCount(event.data.totalSoFar);
        setStatus(`Loading... Parsed ${event.data.totalSoFar} rows`);
      } else if (type === 'DONE') {
        const end = performance.now();
        const duration = ((end - start) / 1000).toFixed(2);
        console.log(`Parsing completed in ${duration} seconds`);
        setRowCount(event.data.totalRows);
        setStatus(`Finished! Total rows: ${event.data.totalRows}`);
      } else if (type === 'ERROR') {
        setStatus(`Error: ${event.data.error}`);
      }
    };

    workerRef.current.postMessage({ file });
  };

  const Row = ({ index, style }: { index: number; style: CSSProperties }) => {
    const row = rowCacheRef.current[index];

    return (
      <div
        style={style}
        className="flex items-center border-b border-slate-200 bg-white px-4 text-sm text-slate-700"
      >
        {row ? row.join(' | ') : 'Loading...'}
      </div>
    );
  };

  const LoadDefaultMessage = () => {
    if (status === '') {
      return <p className="text-gray-600">Upload a CSV file to process.</p>;
    }

    return null;
  };

  const OptimizedList = () => {
    if (status === '' || rowCount === 0) return null;

    return (
      <div className="overflow-hidden rounded border border-gray-300">
        <List
          style={{ height: 500, width: '100%' }}
          rowCount={rowCount}
          rowHeight={40}
          overscanCount={5}
          rowComponent={Row as any}
          rowProps={{} as any}
          onRowsRendered={({ startIndex, stopIndex }) => {
            void loadVisibleRows(startIndex, stopIndex);
          }}
        />
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 shadow-sm">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium ${mode === 'traditional' ? 'text-slate-900' : 'text-slate-500'}`}
          >
            Traditional
          </span>

          <button
            type="button"
            role="switch"
            aria-checked={mode === 'optimized'}
            onClick={handleModeChange}
            className={`relative inline-flex h-7 w-14 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              mode === 'optimized' ? 'bg-blue-600' : 'bg-slate-300'
            }`}
          >
            <span
              className={`inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform duration-200 ${
                mode === 'optimized' ? 'translate-x-7' : 'translate-x-1'
              }`}
            />
          </button>

          <span
            className={`text-sm font-medium ${mode === 'optimized' ? 'text-slate-900' : 'text-slate-500'}`}
          >
            Optimized
          </span>
        </div>

        <input
          type="file"
          accept=".csv"
          onChange={handleFileUpload}
          className="block rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm file:mr-3 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-blue-700"
        />
      </div>

      <LoadDefaultMessage />
      {mode === 'optimized' ? <OptimizedList /> : null}
      <p className="font-semibold text-gray-600">{status}</p>
    </div>
  );
}