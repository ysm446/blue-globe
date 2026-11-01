import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('weatherApi', {
  getWind: () => ipcRenderer.invoke('wind:get'),
  getClouds: () => ipcRenderer.invoke('clouds:get'),
  setMode: (mode: string) => ipcRenderer.invoke('mode:set', mode),
  getTexture: (name: string) => ipcRenderer.invoke('texture:get', name),
  getNews: () => ipcRenderer.invoke('news:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:set', settings),
  searchLocations: (query: string) => ipcRenderer.invoke('locations:search', query),
  listModels: (modelsDir: string) => ipcRenderer.invoke('models:list', modelsDir),
  pickFolder: (defaultPath: string) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
});
