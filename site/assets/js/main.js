// Entry point for every page.
import { applyDevice } from './ui/device.js';
import { enableFocusAll } from './ui/focus.js';
import './ui/shell.js';
import './ui/pwa.js';
import './widgets/fm1-panel.js';
import './widgets/synth-lab.js';
import './widgets/voice-stack.js';
import './widgets/basics.js';
import './widgets/space-lab.js';
import './widgets/fm-lab.js';
import './widgets/chip-lab.js';
import './widgets/aks-lab.js';
import './widgets/history-timeline.js';
import './widgets/hw-check.js';

// Every widget above is defined (and the ones already in the page built), so
// the page can now be put into the selected device's control names.
applyDevice();
// Every playable panel gets a Focus button.
enableFocusAll();
