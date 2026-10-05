// Mandatory independent root corpus. Core CI also runs the complete legacy
// account/relay corpus separately, so no existing acceptance is replaced.
process.env.NEEDWARE_TEST_ROOT_FOCUS='1';
await import('./run-account-acceptance.mjs');
