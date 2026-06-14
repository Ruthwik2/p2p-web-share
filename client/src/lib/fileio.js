/**
 * Read a Blob/File slice into an ArrayBuffer using the FileReader API.
 *
 * The brief calls for reading file data through the browser's FileReader API;
 * this wraps the callback-based reader in a promise so the transfer pipeline can
 * await it cleanly. (A streaming variant writing into OPFS is the documented
 * path for the >500 MB large-file extension.)
 */
export function readBlobAsArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.onabort = () => reject(new Error('Reading the file was aborted.'));
    reader.readAsArrayBuffer(blob);
  });
}
