import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('weatherApi', {
  getWind: (at?: string) => ipcRenderer.invoke('wind:get', at),
  getClouds: (at?: string) => ipcRenderer.invoke('clouds:get', at),
  setMode: (mode: string) => ipcRenderer.invoke('mode:set', mode),
  setGraphics: (graphics: unknown) => ipcRenderer.invoke('graphics:set', graphics),
  getGraphicsDefaults: () => ipcRenderer.invoke('graphics:defaults'),
  setPanels: (panels: unknown) => ipcRenderer.invoke('panels:set', panels),
  getTexture: (name: string) => ipcRenderer.invoke('texture:get', name),
  getEarthTile: (layer: string, col: number, row: number) => ipcRenderer.invoke('earth-tile:get', layer, col, row),
  getNews: (at?: string) => ipcRenderer.invoke('news:get', at),
  getPlaceNews: (name: string, latitude: number, longitude: number, at?: string) =>
    ipcRenderer.invoke('news:place', name, latitude, longitude, at),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:set', settings),
  searchLocations: (query: string) => ipcRenderer.invoke('locations:search', query),
  revealScreenshot: (filePath: string) => ipcRenderer.invoke('screenshot:reveal', filePath),
  onScreenshot: (callback: (filePath: string | null) => void) => {
    ipcRenderer.on('screenshot:done', (_event, filePath: string | null) => callback(filePath));
  },
});
