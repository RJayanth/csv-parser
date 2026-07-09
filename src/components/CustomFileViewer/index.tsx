import {
  useState,
  useEffect,
  useRef,
  type ChangeEvent,
  type CSSProperties,
} from 'react';
import { List } from 'react-window';

import ParseWorker from '../../parser.worker.js?worker'; // Import the worker script

type Mode = 'traditional' | 'optimized';

type ParsedRow = string[];

type WorkerMessageData =
  | { type: 'BATCH'; rows: ParsedRow[]; totalSoFar: number }
  | { type: 'DONE'; totalRows: number }
  | { type: 'ERROR'; error: string };

export default function CustomFileViewer() {
  const [data, setData] = useState<ParsedRow[]>([]);
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState<Mode>('traditional');
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    // Clean up worker on unmount
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const resetState = () => {
    setData([]);
    setStatus('');
    workerRef.current?.terminate();
    workerRef.current = null;
  };

  const handleModeChange = () => {
    const newMode = mode === 'optimized' ? 'traditional' : 'optimized';
    resetState();
    setMode(newMode);
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus('Processing...');
    setData([]); // Clear old data

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
        setData(rows);
        setStatus(`Finished! Total rows: ${rows.length}`);
      };

      reader.onerror = () => {
        setStatus(
          `Traditional mode could not read ${file.name}. Large CSVs can exceed browser memory limits. Switch to Optimized mode for better handling.`,
        );
      };

      reader.readAsText(file);
    } else {
      // Terminate existing worker if any
      workerRef.current?.terminate();

      // Instantiate our custom worker
      workerRef.current = new ParseWorker();

      // Listen for rows streaming back from the worker
      workerRef.current.onmessage = (e: MessageEvent<WorkerMessageData>) => {
        const { type } = e.data;

        if (type === 'BATCH') {
          const { rows, totalSoFar } = e.data;
          setData((prevData) => [...prevData, ...rows]);
          setStatus(`Loading... Parsed ${totalSoFar} rows`);
        } else if (type === 'DONE') {
          setStatus(`Finished! Total rows: ${e.data.totalRows}`);
        } else if (type === 'ERROR') {
          setStatus(`Error: ${e.data.error}`);
        }
      };

      // Pass the file handle to the worker.
      // This doesn't copy the 1GB file in memory; it passes a reference.
      workerRef.current.postMessage({ file });
    }
  };

  type RowRenderProps = {
    ariaAttributes: {
      'aria-posinset': number;
      'aria-setsize': number;
      role: 'listitem';
    };
    index: number;
    style: CSSProperties;
  };

  const Row = ({ index, style }: RowRenderProps) => (
    <div
      style={style}
      className="border-b flex items-center px-4 bg-white text-sm"
    >
      {/* data[index] is an array of columns parsed by our worker */}
      {data[index] ? data[index].join(' | ') : 'Loading...'}
    </div>
  );

  const LoadDefaultMessage = () => {
    if (status === '') {
      return (
        <p className="text-gray-600">Upload a CSV file to process.</p>
      );
    }
  };

  const OptimizedList = () => {
    if (status === '') return;
    return data?.length ? (
      <List
        rowCount={data.length}
        rowHeight={40}
        className="border border-gray-300 rounded"
        rowComponent={Row}
        rowProps={{} as any}
        style={{ height: 500, width: '100%' }}
      />
    ) : (
      <p className="text-gray-600">No data to display.</p>
    );
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
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
      <p className="text-gray-600 font-semibold">{status}</p>
    </div>
  );
}
