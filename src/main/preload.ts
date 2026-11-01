import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('weatherApi', {
  getWind: () => ipcRenderer.invoke('wind:get'),
  getClouds: () => ipcRenderer.invoke('clouds:get'),
  setMode: (mode: string) => ipcRenderer.invoke('mode:set', mode),
  setGraphics: (graphics: unknown) => ipcRenderer.invoke('graphics:set', graphics),
  getGraphicsDefaults: () => ipcRenderer.invoke('graphics:defaults'),
  getTexture: (name: string) => ipcRenderer.invoke('texture:get', name),
  getEarthTile: (layer: string, col: number, row: number) => ipcRenderer.invoke('earth-tile:get', layer, col, row),
  getNews: () => ipcRenderer.invoke('news:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:set', settings),
  searchLocations: (query: string) => ipcRenderer.invoke('locations:search', query),
  listModels: (modelsDir: string) => ipcRenderer.invoke('models:list', modelsDir),
  pickFolder: (defaultPath: string) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  revealScreenshot: (filePath: string) => ipcRenderer.invoke('screenshot:reveal', filePath),
  onScreenshot: (callback: (filePath: string | null) => void) => {
    ipcRenderer.on('screenshot:done', (_event, filePath: string | null) => callback(filePath));
  },
});
