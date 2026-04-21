const CACHE_NAME = 'dead-air-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

// Install — cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', e => {
  // Don't intercept RunPod API calls
  if (e.request.url.includes('api.runpod.ai')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// Background sync — poll pending jobs
self.addEventListener('sync', e => {
  if (e.tag === 'poll-jobs') {
    e.waitUntil(pollPendingJobs());
  }
});

// Periodic background sync (Android Chrome only)
self.addEventListener('periodicsync', e => {
  if (e.tag === 'poll-jobs') {
    e.waitUntil(pollPendingJobs());
  }
});

async function pollPendingJobs() {
  // Read pending jobs from IndexedDB via message to client
  // If no clients open, we can't access localStorage — use IDB instead
  const clients = await self.clients.matchAll();
  if (clients.length > 0) {
    clients.forEach(c => c.postMessage({ type: 'POLL_JOBS' }));
    return;
  }

  // No client open — do direct polling
  try {
    const db = await openDB();
    const jobs = await getAllJobs(db);
    const pending = jobs.filter(j => j.status === 'pending');

    for (const job of pending) {
      try {
        const res = await fetch(
          `https://api.runpod.ai/v2/${job.endpointId}/status/${job.jobId}`,
          { headers: { Authorization: `Bearer ${job.apiKey}` } }
        );
        const data = await res.json();
        if (data.status === 'COMPLETED') {
          await updateJob(db, job.jobId, { status: 'completed', output: data.output });
          await showNotification(job.jobId);
        } else if (data.status === 'FAILED') {
          await updateJob(db, job.jobId, { status: 'failed', error: data.error });
          await showFailNotification(job.jobId);
        }
      } catch(e) {
        console.error('Poll error for job', job.jobId, e);
      }
    }
  } catch(e) {
    console.error('Background poll error:', e);
  }
}

async function showNotification(jobId) {
  return self.registration.showNotification('DEAD AIR', {
    body: `Shot complete — tap to view`,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: jobId,
    data: { jobId },
    vibrate: [200, 100, 200],
  });
}

async function showFailNotification(jobId) {
  return self.registration.showNotification('DEAD AIR', {
    body: `Job failed — tap to view details`,
    icon: '/icon-192.png',
    tag: jobId,
    data: { jobId },
  });
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({ type: 'OPEN_JOB', jobId: e.notification.data.jobId });
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});

// ── Tiny IndexedDB helpers ──────────────────────────────────────────────────

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('dead-air-jobs', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('jobs', { keyPath: 'jobId' });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function getAllJobs(db) {
  return new Promise((res, rej) => {
    const tx  = db.transaction('jobs', 'readonly');
    const req = tx.objectStore('jobs').getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function updateJob(db, jobId, updates) {
  return new Promise((res, rej) => {
    const tx    = db.transaction('jobs', 'readwrite');
    const store = tx.objectStore('jobs');
    const get   = store.get(jobId);
    get.onsuccess = e => {
      const job = { ...e.target.result, ...updates };
      const put = store.put(job);
      put.onsuccess = () => res();
      put.onerror   = e => rej(e.target.error);
    };
    get.onerror = e => rej(e.target.error);
  });
}
