/**
 * Utility functions for path manipulation
 */

/**
 * Identifies top-level removed directories from a list of removal events.
 * Filters out subdirectories that are removed as a consequence of their parent's removal.
 * 
 * @param dirRemoveQueue List of removed directory paths
 * @returns List of top-level removed directory paths
 */
function identifyDirRename(dirRemoveQueue) {
  // split the path with / to find the depth of the path
  // one with the least depth is the parent node that is a potential renamed candidate
  const pathDepth = dirRemoveQueue
    .map(p => ({ path: p, depth: p.split(/[/\\]/g).length }))
    .sort((a, b) => a.depth - b.depth);

  const candidates = [];

  for (const { path } of pathDepth) {
    // Check if this path is a child of any existing candidate
    const isChild = candidates.some(candidate => {
      // Normalize for comparison
      const pNorm = path.replace(/\\/g, '/');
      const cNorm = candidate.replace(/\\/g, '/');
      
      // Exact match (duplicate) or Child
      if (pNorm === cNorm) return true;
      
      // Check if pNorm starts with cNorm + '/'
      // Handle case where cNorm ends with / (e.g. root)
      const prefix = cNorm.endsWith('/') ? cNorm : cNorm + '/';
      return pNorm.startsWith(prefix);
    });

    if (!isChild) {
      candidates.push(path);
    }
  }

  return candidates;
}

const paths = [ "/sand",
 "/sand/kumar",
 "/sand/kumar/gr",
 "/test",
 "/test/test2",
 "/test/test2/test3",
 "/test/test2/test3/test4"]

 const result = identifyDirRename(paths);
 console.log(result)