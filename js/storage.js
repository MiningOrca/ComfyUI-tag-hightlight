const DB_NAME = "semantic-tag-highlighter";
const DB_VERSION = 1;

const CLASSIFICATIONS = "classifications";
const OVERRIDES = "overrides";

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains(CLASSIFICATIONS)) {
                db.createObjectStore(CLASSIFICATIONS, { keyPath: "key" });
            }

            if (!db.objectStoreNames.contains(OVERRIDES)) {
                db.createObjectStore(OVERRIDES, { keyPath: "tag" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    return dbPromise;
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function getClassifications(keys) {
    if (!keys.length) return [];

    const db = await openDb();
    const tx = db.transaction(CLASSIFICATIONS, "readonly");
    const store = tx.objectStore(CLASSIFICATIONS);

    return Promise.all(
        keys.map((key) => requestToPromise(store.get(key)))
    );
}

export async function putClassifications(records) {
    if (!records.length) return;

    const db = await openDb();
    const tx = db.transaction(CLASSIFICATIONS, "readwrite");
    const store = tx.objectStore(CLASSIFICATIONS);

    for (const record of records) {
        store.put(record);
    }

    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function clearClassifications() {
    const db = await openDb();
    const tx = db.transaction(CLASSIFICATIONS, "readwrite");
    tx.objectStore(CLASSIFICATIONS).clear();

    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function getOverrides(tags) {
    if (!tags.length) return [];

    const db = await openDb();
    const tx = db.transaction(OVERRIDES, "readonly");
    const store = tx.objectStore(OVERRIDES);

    return Promise.all(
        tags.map((tag) => requestToPromise(store.get(tag)))
    );
}

export async function setOverride(tag, category) {
    const db = await openDb();
    const tx = db.transaction(OVERRIDES, "readwrite");
    tx.objectStore(OVERRIDES).put({ tag, category });

    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function deleteOverride(tag) {
    const db = await openDb();
    const tx = db.transaction(OVERRIDES, "readwrite");
    tx.objectStore(OVERRIDES).delete(tag);

    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function clearOverrides() {
    const db = await openDb();
    const tx = db.transaction(OVERRIDES, "readwrite");
    tx.objectStore(OVERRIDES).clear();

    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
