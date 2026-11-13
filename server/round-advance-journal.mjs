// Separate namespace; same single-writer atomic-rename/checksum discipline.
// This does not claim fsync or power-loss durability.
export {readFinalization as readAdvance,writeFinalization as writeAdvance,commitFinalization as commitAdvance} from './finalization-journal.mjs';
