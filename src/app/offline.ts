// Registers the service worker (sw.js at the site root, roadmap I3) that
// keeps the app itself on the device so it opens with no signal, and makes
// "Add to Home Screen" a real installable app (with manifest.webmanifest).
// Only on https or localhost: browsers refuse service workers elsewhere,
// and the test suite loads the page from file://, where it's skipped.
export function registerOfflineSupport(): void {
  if (!('serviceWorker' in navigator)) return;
  const ok = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!ok) return;
  // After the page has loaded, so it never competes with startup.
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('Offline support could not start', err);
    });
  });
}

registerOfflineSupport();
