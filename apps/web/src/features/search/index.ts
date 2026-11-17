/*
 * Public API of the search feature (BUILD-ORDER "Web feature exports", fixed in Phase 1c). Other parts of the app
 * import only from here; the header renders `HeaderSearch`.
 */

/** The labelled "find people" combobox in the header (F-59, F-62, F-63). */
export { HeaderSearch } from './components/HeaderSearch';
