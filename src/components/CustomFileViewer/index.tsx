import { useState, useEffect, useRef, type ChangeEvent, type CSSProperties } from 'react';
import { List } from 'react-window';

import ParseWorker from '../../parser.worker.js?worker'; // Import the worker script

type ParsedRow = string[];

type WorkerMessageData =
  | { type: 'BATCH'; rows: ParsedRow[]; totalSoFar: number }
  | { type: 'DONE'; totalRows: number }
  | { type: 'ERROR'; error: string };

export default function CustomFileViewer() {
  const [data, setData] = useState<ParsedRow[]>([]);
  const [status, setStatus] = useState('Idle');
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    // Clean up worker on unmount
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus('Processing...');
    setData([]); // Clear old data

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
    <div style={style} className="border-b flex items-center px-4 bg-white text-sm">
      {/* data[index] is an array of columns parsed by our worker */}
      {data[index] ? data[index].join(' | ') : 'Loading...'}
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-4">
        <input type="file" accept=".csv" onChange={handleFileUpload} className="block mb-2" />
        <span className="text-gray-600 font-semibold">{status}</span>
      </div>

      {data.length > 0 && (
        <List
          rowCount={data.length}
          rowHeight={40}
          className="border border-gray-300 rounded"
          rowComponent={Row}
          rowProps={{} as any}
          style={{ height: 500, width: '100%' }}
        />
      )}
    </div>
  );
}