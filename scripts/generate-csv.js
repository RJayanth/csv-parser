// generate-csv.js
import fs from 'fs';

const FILE_NAME = 'dummy_2gb.csv';
const TARGET_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // Exactly 2 GB

const writeStream = fs.createWriteStream(FILE_NAME);

// Write CSV Header
writeStream.write('id,name,email,age,city\n');

let currentSize = writeStream.bytesWritten;
let id = 1;

console.log("Generating 2GB CSV file... Please wait.");

function writeData() {
  let ok = true;
  
  // Keep writing in a loop until the stream buffer is full OR we hit 2GB
  while (currentSize < TARGET_SIZE_BYTES && ok) {
    const row = `${id},User_${id},user_${id}@example.com,${20 + (id % 40)},City_${id % 100}\n`;
    
    // write() returns false if the internal buffer is full (backpressure)
    ok = writeStream.write(row);
    currentSize += Buffer.byteLength(row);
    id++;
  }

  if (currentSize < TARGET_SIZE_BYTES) {
    // If we stopped because of backpressure, wait for 'drain' to clear the buffer and continue
    writeStream.once('drain', writeData);
  } else {
    // We hit 2GB! Close the file.
    writeStream.end();
    console.log(`\n Success! Created ${FILE_NAME}`);
    console.log(`Total Rows Generated: ${id.toLocaleString()}`);
    console.log(`Final File Size: ${(currentSize / (1024 * 1024 * 1024)).toFixed(2)} GB`);
  }
}

writeData();