const overlayApi = window.telefonOverlay || null;
const overlayRootElement = document.getElementById('overlayRoot');
const overlayUsersElement = document.getElementById('overlayUsers');

let removeOverlayListener = () => {};
let overlayState = { enabled: false, unlocked: false, users: [] };
let activePointerId = null;
let isDragging = false;

renderOverlayState(overlayApi && typeof overlayApi.getState === 'function'
    ? overlayApi.getState()
    : overlayState);

if (overlayApi && typeof overlayApi.onState === 'function') {
    removeOverlayListener = overlayApi.onState(renderOverlayState);
}

overlayRootElement.addEventListener('pointerdown', handlePointerDown);
overlayRootElement.addEventListener('pointermove', handlePointerMove);
overlayRootElement.addEventListener('pointerup', handlePointerUp);
overlayRootElement.addEventListener('pointercancel', handlePointerCancel);

window.addEventListener('beforeunload', () => {
    removeOverlayListener();
});

function renderOverlayState(state) {
    const users = Array.isArray(state && state.users) ? state.users : [];
    overlayState = {
        enabled: Boolean(state && state.enabled),
        unlocked: Boolean(state && state.unlocked),
        users,
    };
    const isVisible = overlayState.enabled && users.length > 0;

    overlayRootElement.classList.toggle('hidden', !isVisible);
    overlayRootElement.classList.toggle('drag-enabled', overlayState.unlocked);
    document.body.classList.toggle('overlay-unlocked', overlayState.unlocked);
    document.body.classList.toggle('dragging', isDragging);
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

    if (!overlayState.unlocked && isDragging) {
        finishDrag();
    }
}

function handlePointerDown(event) {
    if (!overlayState.unlocked || event.button !== 0 || !overlayState.enabled) {
        return;
    }

    activePointerId = event.pointerId;
    isDragging = true;
    document.body.classList.add('dragging');
    event.preventDefault();
    overlayRootElement.setPointerCapture(activePointerId);

    if (overlayApi && typeof overlayApi.startDrag === 'function') {
        overlayApi.startDrag({
            screenX: event.screenX,
            screenY: event.screenY,
        });
    }
}

function handlePointerMove(event) {
    if (!isDragging || event.pointerId !== activePointerId) {
        return;
    }

    if (overlayApi && typeof overlayApi.moveDrag === 'function') {
        overlayApi.moveDrag({
            screenX: event.screenX,
            screenY: event.screenY,
        });
    }
}

function handlePointerUp(event) {
    if (!isDragging || event.pointerId !== activePointerId) {
        return;
    }

    finishDrag(event);
}

function handlePointerCancel(event) {
    if (!isDragging || event.pointerId !== activePointerId) {
        return;
    }

    finishDrag(event);
}

function finishDrag(event) {
    if (activePointerId !== null && overlayRootElement.hasPointerCapture(activePointerId)) {
        overlayRootElement.releasePointerCapture(activePointerId);
    }

    if (event && overlayApi && typeof overlayApi.endDrag === 'function') {
        overlayApi.endDrag({
            screenX: event.screenX,
            screenY: event.screenY,
        });
    }

    activePointerId = null;
    isDragging = false;
    document.body.classList.remove('dragging');
}
