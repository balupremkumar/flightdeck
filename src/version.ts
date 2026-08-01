// version.ts — single source of truth for the app version.
//
// This lived as an export inside Settings.tsx, which meant anything else
// wanting to show the version had to import a settings module (or, worse,
// duplicate the literal and let it drift — exactly what happened with the
// storage keys). Keep this in step with package.json and tauri.conf.json.
export const APP_VERSION = "0.4.0";
