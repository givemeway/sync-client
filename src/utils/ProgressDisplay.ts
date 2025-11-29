// src/utils/ProgressDisplay.ts - Clean single-line progress updates

/**
 * ProgressDisplay provides clean, in-place progress updates
 * Updates a single line instead of scrolling
 */
export class ProgressDisplay {
  private lastLine: string = '';
  private actionLine: string = '';
  private enabled: boolean = true;
  
  /**
   * Clear the current progress line
   */
  clear(): void {
    if (!this.enabled) return;
    // Clear both lines
    process.stdout.write('\r' + ' '.repeat(this.lastLine.length) + '\r');
    if (this.actionLine) {
      process.stdout.write('\x1b[1A'); // Move up one line
      process.stdout.write('\r' + ' '.repeat(this.actionLine.length) + '\r');
    }
    this.lastLine = '';
    this.actionLine = '';
  }
  
  /**
   * Update progress in place (same line)
   */
  update(message: string): void {
    if (!this.enabled) return;
    
    // Truncate if too long for terminal
    const maxWidth = process.stdout.columns || 80;
    const truncated = message.length > maxWidth 
      ? message.substring(0, maxWidth - 3) + '...'
      : message;
    
    // Clear previous line and write new one
    process.stdout.write('\r' + ' '.repeat(this.lastLine.length) + '\r');
    process.stdout.write(truncated);
    
    this.lastLine = truncated;
  }
  
  /**
   * Update action and status (two lines)
   */
  updateAction(action: string, status: string): void {
    if (!this.enabled) return;
    
    const maxWidth = process.stdout.columns || 80;
    const truncatedAction = action.length > maxWidth 
      ? action.substring(0, maxWidth - 3) + '...'
      : action;
    const truncatedStatus = status.length > maxWidth 
      ? status.substring(0, maxWidth - 3) + '...'
      : status;
    
    // Clear both lines if they exist
    if (this.lastLine) {
      process.stdout.write('\r' + ' '.repeat(this.lastLine.length) + '\r');
    }
    if (this.actionLine) {
      process.stdout.write('\x1b[1A'); // Move up
      process.stdout.write('\r' + ' '.repeat(this.actionLine.length) + '\r');
    }
    
    // Write action line
    process.stdout.write(truncatedAction + '\n');
    // Write status line
    process.stdout.write(truncatedStatus);
    
    this.actionLine = truncatedAction;
    this.lastLine = truncatedStatus;
  }
  
  /**
   * Write a permanent line (with newline)
   */
  log(message: string): void {
    this.clear();
    console.log(message);
  }
  
  /**
   * Show scanning progress
   */
  scanning(current: number, total: number, filename: string): void {
    const percentage = total > 0 ? Math.floor((current / total) * 100) : 0;
    const bar = this.createProgressBar(percentage, 20);
    const truncatedFilename = filename.length > 40 
      ? '...' + filename.substring(filename.length - 37)
      : filename;
    
    this.update(`📊 Scanning: ${bar} ${percentage}% (${current}/${total}) - ${truncatedFilename}`);
  }
  
  /**
   * Show operation progress (upload, hash, etc)
   */
  operation(type: string, current: number, total: number, item: string): void {
    const percentage = total > 0 ? Math.floor((current / total) * 100) : 0;
    const bar = this.createProgressBar(percentage, 15);
    const truncatedItem = item.length > 35
      ? '...' + item.substring(item.length - 32)
      : item;
    
    this.update(`⚡ ${type}: ${bar} ${percentage}% (${current}/${total}) - ${truncatedItem}`);
  }
  
  /**
   * Show watching status
   */
  watching(path: string, stats: { files: number; dirs: number; changes: number }): void {
    this.update(`👀 Watching: ${stats.files} files, ${stats.dirs} dirs | Changes: ${stats.changes}`);
  }
  
  /**
   * Create a progress bar
   */
  private createProgressBar(percentage: number, width: number): string {
    const filled = Math.floor((percentage / 100) * width);
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }
  
  /**
   * Enable/disable progress updates
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

// Export a singleton instance
export const progress = new ProgressDisplay();
