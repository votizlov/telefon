const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('telefonOverlay', {
    getState() {
        return ipcRenderer.sendSync('overlay:get-state');
    },
    onState(callback) {
        if (typeof callback !== 'function') {
            return () => {};
        }

        const listener = (_event, payload) => {
            callback(payload && typeof payload === 'object' ? payload : { enabled: false, users: [] });
        };

        ipcRenderer.on('overlay:state', listener);
        return () => {
            ipcRenderer.removeListener('overlay:state', listener);
        };
    },
});
