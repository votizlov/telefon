const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('telefonOverlay', {
    getState() {
        return ipcRenderer.sendSync('overlay:get-state');
    },
    startDrag(payload) {
        ipcRenderer.send('overlay:drag-start', payload);
    },
    moveDrag(payload) {
        ipcRenderer.send('overlay:drag-move', payload);
    },
    endDrag(payload) {
        ipcRenderer.send('overlay:drag-end', payload);
    },
    onState(callback) {
        if (typeof callback !== 'function') {
            return () => {};
        }

        const listener = (_event, payload) => {
            callback(payload && typeof payload === 'object' ? payload : { enabled: false, unlocked: false, users: [] });
        };

        ipcRenderer.on('overlay:state', listener);
        return () => {
            ipcRenderer.removeListener('overlay:state', listener);
        };
    },
});
