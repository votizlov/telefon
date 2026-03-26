const overlayApi = window.telefonOverlay || null;
const overlayRootElement = document.getElementById('overlayRoot');
const overlayUsersElement = document.getElementById('overlayUsers');

let removeOverlayListener = () => {};

renderOverlayState(overlayApi && typeof overlayApi.getState === 'function'
    ? overlayApi.getState()
    : { enabled: false, users: [] });

if (overlayApi && typeof overlayApi.onState === 'function') {
    removeOverlayListener = overlayApi.onState(renderOverlayState);
}

window.addEventListener('beforeunload', () => {
    removeOverlayListener();
});

function renderOverlayState(state) {
    const users = Array.isArray(state && state.users) ? state.users : [];
    const isVisible = Boolean(state && state.enabled) && users.length > 0;

    overlayRootElement.classList.toggle('hidden', !isVisible);
    overlayUsersElement.innerHTML = '';

    users.forEach((user) => {
        const listItem = document.createElement('li');
        listItem.className = 'overlay-user';
        listItem.title = user.id || user.nickname || '';
        listItem.classList.toggle('speaking', Boolean(user.isSpeaking));

        const nameElement = document.createElement('span');
        nameElement.className = 'overlay-user-name';
        nameElement.textContent = user.nickname || user.id;

        listItem.appendChild(nameElement);
        overlayUsersElement.appendChild(listItem);
    });
}
