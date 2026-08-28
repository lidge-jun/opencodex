/**
 * Stable public provider-registry surface.
 *
 * The ordered provider declarations live separately from the query/validation
 * layer so consumers keep one import path without coupling catalog data to helpers.
 */
export * from "./registry-catalog";
export * from "./registry-query";
