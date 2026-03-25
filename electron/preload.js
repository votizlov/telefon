const { contextBridge, ipcRenderer } = require('electron/renderer');

contextBridge.exposeInMainWorld('telefonDesktop', {
    isDesktop: true,
    getSettings() {
        return ipcRenderer.sendSync('settings:get');
    },
    updateSettings(patch) {
        return ipcRenderer.sendSync('settings:update', patch);
    },
    onPushToTalkState(callback) {
        if (typeof callback !== 'function') {
            return () => {};
        }

        const listener = (_event, payload) => {
            callback(Boolean(payload && payload.isActive));
        };

        ipcRenderer.on('ptt:state', listener);
        return () => {
            ipcRenderer.removeListener('ptt:state', listener);
        };
    },
    getDesktopInfo() {
        return ipcRenderer.sendSync('desktop:get-info');
    },
});
