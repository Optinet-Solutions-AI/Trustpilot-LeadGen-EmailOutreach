/**
 * Spintax parser — resolves {option1|option2|option3} syntax.
 * Supports nesting: {Hi|{Hey|Howdy} there}
 * Each call produces a unique random resolution for email content variation.
 */

/**
 * Resolves all spintax groups in a string.
 * Uses a stack-based approach to handle nested braces correctly.
 * Returns the input unchanged if no spintax braces are found.
 */
export function resolveSpintax(text: string): string {
  let result = text;
  let maxIterations = 50; // safety limit to prevent infinite loops on malformed input

  while (maxIterations-- > 0) {
    // Find the innermost {…} group (no nested braces inside)
    const match = result.match(/\{([^{}]+)\}/);
    if (!match) break;

    const fullMatch = match[0];
    const options = match[1].split('|');
    const chosen = options[Math.floor(Math.random() * options.length)];

    // Replace only the first occurrence of this exact match
    result = result.replace(fullMatch, chosen);
  }

  return result;
}
