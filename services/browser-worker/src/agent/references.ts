/**
 * The owner can point at an element of the page while writing Instructions:
 * the Monitor form's preview inserts `@[what it showed](path)`, where path is
 * the element's XPath in the short form the plan's outline uses. Every prompt
 * that reads Instructions explains it the same way.
 */
export const ELEMENT_REFERENCES = `The Instructions may point at parts of the page as @[text](path). The owner picked that element on the page itself: text is what it showed then (it may have changed since), and path is where it is, written as in the outline (no /html/body, no [1]). Read it as naming that element and everything inside it.`;
