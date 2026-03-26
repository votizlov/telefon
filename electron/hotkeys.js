const MODIFIER_TOKEN_ORDER = ['CTRL', 'ALT', 'SHIFT', 'META'];

const MODIFIER_KEY_ALIASES = {
    CTRL: ['LEFT CTRL', 'RIGHT CTRL', 'CTRL'],
    ALT: ['LEFT ALT', 'RIGHT ALT', 'ALT GR', 'ALT'],
    SHIFT: ['LEFT SHIFT', 'RIGHT SHIFT', 'SHIFT'],
    META: ['LEFT META', 'RIGHT META', 'META'],
};

const SPECIAL_KEY_ALIASES = {
    SPACE: ['SPACE'],
    ENTER: ['ENTER', 'RETURN'],
    TAB: ['TAB'],
    ESCAPE: ['ESCAPE'],
    BACKSPACE: ['BACKSPACE'],
    DELETE: ['DELETE'],
    UP: ['UP'],
    DOWN: ['DOWN'],
    LEFT: ['LEFT'],
    RIGHT: ['RIGHT'],
    'MOUSE LEFT': ['MOUSE LEFT'],
    'MOUSE RIGHT': ['MOUSE RIGHT'],
    'MOUSE MIDDLE': ['MOUSE MIDDLE'],
    'MOUSE X1': ['MOUSE X1'],
    'MOUSE X2': ['MOUSE X2'],
};

const SPECIAL_KEY_TOKEN_ALIASES = {
    SPACE: 'SPACE',
    ENTER: 'ENTER',
    RETURN: 'ENTER',
    TAB: 'TAB',
    ESCAPE: 'ESCAPE',
    ESC: 'ESCAPE',
    BACKSPACE: 'BACKSPACE',
    DELETE: 'DELETE',
    UP: 'UP',
    ARROWUP: 'UP',
    DOWN: 'DOWN',
    ARROWDOWN: 'DOWN',
    LEFT: 'LEFT',
    ARROWLEFT: 'LEFT',
    RIGHT: 'RIGHT',
    ARROWRIGHT: 'RIGHT',
    MOUSELEFT: 'MOUSE LEFT',
    'MOUSE LEFT': 'MOUSE LEFT',
    MOUSE1: 'MOUSE LEFT',
    'MOUSE 1': 'MOUSE LEFT',
    MOUSERIGHT: 'MOUSE RIGHT',
    'MOUSE RIGHT': 'MOUSE RIGHT',
    MOUSE2: 'MOUSE RIGHT',
    'MOUSE 2': 'MOUSE RIGHT',
    MOUSEMIDDLE: 'MOUSE MIDDLE',
    'MOUSE MIDDLE': 'MOUSE MIDDLE',
    MOUSE3: 'MOUSE MIDDLE',
    'MOUSE 3': 'MOUSE MIDDLE',
    MOUSEBACK: 'MOUSE X1',
    'MOUSE BACK': 'MOUSE X1',
    MOUSEX1: 'MOUSE X1',
    'MOUSE X1': 'MOUSE X1',
    MOUSE4: 'MOUSE X1',
    'MOUSE 4': 'MOUSE X1',
    MOUSEFORWARD: 'MOUSE X2',
    'MOUSE FORWARD': 'MOUSE X2',
    MOUSEX2: 'MOUSE X2',
    'MOUSE X2': 'MOUSE X2',
    MOUSE5: 'MOUSE X2',
    'MOUSE 5': 'MOUSE X2',
};

function normalizeModifierToken(token) {
    const value = token.trim().toUpperCase();

    if (value === 'CTRL' || value === 'CONTROL' || value === 'CMDORCTRL') {
        return 'CTRL';
    }

    if (value === 'ALT' || value === 'OPTION') {
        return 'ALT';
    }

    if (value === 'SHIFT') {
        return 'SHIFT';
    }

    if (value === 'META' || value === 'SUPER' || value === 'COMMAND' || value === 'CMD') {
        return 'META';
    }

    return null;
}

function normalizeKeyToken(token) {
    const value = token.trim().toUpperCase();

    if (/^[A-Z0-9]$/.test(value)) {
        return value;
    }

    if (/^F([1-9]|1[0-2])$/.test(value)) {
        return value;
    }

    if (value in SPECIAL_KEY_TOKEN_ALIASES) {
        return SPECIAL_KEY_TOKEN_ALIASES[value];
    }

    return null;
}

function formatToken(token) {
    switch (token) {
    case 'CTRL':
        return 'Ctrl';
    case 'ALT':
        return 'Alt';
    case 'SHIFT':
        return 'Shift';
    case 'META':
        return 'Meta';
    case 'SPACE':
        return 'Space';
    case 'ENTER':
        return 'Enter';
    case 'TAB':
        return 'Tab';
    case 'ESCAPE':
        return 'Escape';
    case 'BACKSPACE':
        return 'Backspace';
    case 'DELETE':
        return 'Delete';
    case 'UP':
        return 'Up';
    case 'DOWN':
        return 'Down';
    case 'LEFT':
        return 'Left';
    case 'RIGHT':
        return 'Right';
    case 'MOUSE LEFT':
        return 'MouseLeft';
    case 'MOUSE RIGHT':
        return 'MouseRight';
    case 'MOUSE MIDDLE':
        return 'MouseMiddle';
    case 'MOUSE X1':
        return 'MouseBack';
    case 'MOUSE X2':
        return 'MouseForward';
    default:
        return token;
    }
}

function parseHotkey(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    const rawTokens = value.split('+').map((token) => token.trim()).filter(Boolean);
    if (rawTokens.length === 0) {
        return null;
    }

    const modifiers = [];
    let key = null;

    for (const rawToken of rawTokens) {
        const modifierToken = normalizeModifierToken(rawToken);
        if (modifierToken) {
            if (!modifiers.includes(modifierToken)) {
                modifiers.push(modifierToken);
            }
            continue;
        }

        const keyToken = normalizeKeyToken(rawToken);
        if (!keyToken || key) {
            return null;
        }

        key = keyToken;
    }

    if (!key) {
        return null;
    }

    modifiers.sort((left, right) => MODIFIER_TOKEN_ORDER.indexOf(left) - MODIFIER_TOKEN_ORDER.indexOf(right));
    return {
        modifiers,
        key,
        accelerator: [...modifiers, key].map(formatToken).join('+'),
    };
}

function normalizeHotkey(value) {
    const parsedHotkey = parseHotkey(value);
    return parsedHotkey ? parsedHotkey.accelerator : '';
}

function getPressedKeyNames(downState) {
    if (!downState || typeof downState !== 'object') {
        return new Set();
    }

    return new Set(
        Object.entries(downState)
            .filter(([, isPressed]) => Boolean(isPressed))
            .map(([keyName]) => keyName.toUpperCase())
    );
}

function isModifierPressed(pressedKeys, modifier) {
    return MODIFIER_KEY_ALIASES[modifier].some((keyName) => pressedKeys.has(keyName));
}

function isMainKeyPressed(pressedKeys, key) {
    if (key in SPECIAL_KEY_ALIASES) {
        return SPECIAL_KEY_ALIASES[key].some((keyName) => pressedKeys.has(keyName));
    }

    return pressedKeys.has(key);
}

function isHotkeyPressed(downState, hotkeyValue) {
    const parsedHotkey = typeof hotkeyValue === 'string' ? parseHotkey(hotkeyValue) : hotkeyValue;
    if (!parsedHotkey) {
        return false;
    }

    const pressedKeys = getPressedKeyNames(downState);

    if (!isMainKeyPressed(pressedKeys, parsedHotkey.key)) {
        return false;
    }

    return parsedHotkey.modifiers.every((modifier) => isModifierPressed(pressedKeys, modifier));
}

module.exports = {
    normalizeHotkey,
    parseHotkey,
    isHotkeyPressed,
};
