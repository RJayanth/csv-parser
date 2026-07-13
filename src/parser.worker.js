// parser.worker.js

let db = null;

// Helper to open/initialize IndexedDB inside the worker
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("LargeCSVDatabase", 1);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      // Create a store that uses the row index as the primary key
      if (!database.objectStoreNames.contains("rows")) {
        database.createObjectStore("rows", { keyPath: "id" });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

self.onmessage = async (e) => {
  const { file } = e.data;
  if (!file) return;

  self.postMessage({ type: 'STATUS', message: "Initializing local database..." });
  await initDB();

  // Clear any existing old data before starting a new upload
  await new Promise((res) => {
    const tx = db.transaction("rows", "readwrite");
    tx.objectStoreNames.contains("rows") && tx.objectStore("rows").clear();
    tx.oncomplete = () => res();
  });

  const stream = file.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  
  let leftover = "";
  let rowCount = 0;

  self.postMessage({ type: 'STATUS', message: "Streaming file directly to local storage..." });

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        if (leftover.length > 0) {
          await saveBatchToDB([{ id: rowCount, data: parseCSVLine(leftover) }]);
          rowCount++;
        }

        if (rowCount > 0) {
          self.postMessage({ type: 'PROGRESS', totalSoFar: rowCount });
        }
        break;
      }

      const chunkText = leftover + decoder.decode(value, { stream: true });
      const lines = chunkText.split(/\r?\n/);
      leftover = lines.pop() || "";

      // Format data into objects for IndexedDB
      const dbBatch = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "") continue;
        dbBatch.push({
          id: rowCount, // Key path
          data: parseCSVLine(lines[i])
        });
        rowCount++;
      }

      // Write this chunk batch directly to disk
      if (dbBatch.length > 0) {
        await saveBatchToDB(dbBatch);
      }

      // Keep the main thread updated without sending the actual massive array data
      if (rowCount % 1000 === 0 || rowCount < 1000) {
        self.postMessage({ type: 'PROGRESS', totalSoFar: rowCount });
      }
    }

    self.postMessage({ type: 'DONE', totalRows: rowCount });
  } catch (error) {
    self.postMessage({ type: 'ERROR', error: error.message });
  }
};

function saveBatchToDB(batch) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("rows", "readwrite");
    const store = transaction.objectStore("rows");

    for (const row of batch) {
      store.put(row);
    }

    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e.target.error);
  });
}

function parseCSVLine(text) {
  return text.split(',');
}