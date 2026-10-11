/**
 * One good location fix for "Use my location". A single getCurrentPosition()
 * often returns a cached or Wi-Fi-only fix that is hundreds of metres off, so
 * this watches high-accuracy GPS for a few seconds and keeps the best sample.
 */
export interface Located {
  lon: number;
  lat: number;
  accuracyM: number;
}

export function locateBest(
  onProgress: (accuracyM: number) => void,
  { goodEnoughM = 20, timeoutMs = 12_000 } = {},
): Promise<Located> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Location is not available on this device."));
    let best: Located | undefined;
    const finish = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      if (best) resolve(best);
      else reject(new Error("No GPS fix. Go outdoors or pick the point on the map."));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const fix = { lon: p.coords.longitude, lat: p.coords.latitude, accuracyM: p.coords.accuracy };
        if (!best || fix.accuracyM < best.accuracyM) best = fix;
        onProgress(best.accuracyM);
        if (best.accuracyM <= goodEnoughM) finish();
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          navigator.geolocation.clearWatch(id);
          clearTimeout(timer);
          reject(new Error("Location permission denied. Pick the point on the map instead."));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
    );
    const timer = setTimeout(finish, timeoutMs);
  });
}
