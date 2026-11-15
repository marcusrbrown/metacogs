/**
 * Texts the scrub must find, shared by its unit tests and by the tests that put them through the view and the pre-send guard.
 * Assembled at runtime so no file holds a credential-shaped literal.
 */
const VALUE = ['harbor', 'Moon42'].join('')
const KEY = ['pass', 'word'].join('')
const TOKEN = ['to', 'ken'].join('')
const ESCAPED_KEY = `\\u0070${['ass', 'word'].join('')}`
/** The address the email cases are built on, as parts, and written out and with each escape. Every case below is built from these, so what a test checks for cannot drift from what the cases hold. */
export const EMAIL_LOCAL = 'someone'
export const EMAIL_DOMAIN = ['corp', 'mail.com'].join('-')
const ADDRESS = `${EMAIL_LOCAL}@${EMAIL_DOMAIN}`
const ADDRESS_U = `${EMAIL_LOCAL}\\u0040${EMAIL_DOMAIN}`
const ADDRESS_X = `${EMAIL_LOCAL}\\x40${EMAIL_DOMAIN}`
/**
 * The forms of the address the cases hold: 21, 26 and 24 characters, so each has distinguishing runs of 16. The local part (7) and
 * the domain (13) are shorter than a run, so a test checks them whole, as `EMAIL_PARTS`.
 */
export const EMAIL_ADDRESS_FORMS: readonly string[] = [ADDRESS, ADDRESS_U, ADDRESS_X]
export const EMAIL_PARTS: readonly string[] = [EMAIL_LOCAL, EMAIL_DOMAIN]

/** Each of these holds a credential key next to an assignment, or a known-format secret, in some form. */
export const CREDENTIAL_TEXT_CASES: readonly string[] = [
  `${KEY}=${VALUE}`,
  `${KEY}: ${VALUE}`,
  `"${KEY}":"${VALUE}"`,
  `${KEY}\t=\t${VALUE}`,
  `${KEY}\\t=\\t${VALUE}`,
  `${KEY}\\\\t=\\\\t${VALUE}`,
  `\\"${KEY}\\":\\"${VALUE}\\"`,
  `{${KEY}:["${VALUE}"]}`,
  `${KEY}="[email]${VALUE}"`,
  `${KEY}=[REDACTED]${VALUE}`,
  `${TOKEN}: \${GH_TOKEN}`,
  `${KEY}: <redacted>`,
  `${TOKEN}=***`,
  `\\u0070${['ass', 'word'].join('')}=${VALUE}`,
  `${KEY.slice(0, 4)}\\x${'77'}ord: ${VALUE}`,
  `to\\u006b${['e', 'n'].join('')}=${VALUE}`,
  `{"body":{"${ESCAPED_KEY}":"${VALUE}"},"body":null}`,
  `[tool] write {"body":{"${ESCAPED_KEY}":"${VALUE}"},"body":null}`,
  `[tool] read [{"${ESCAPED_KEY}":"${VALUE}"}]`,
  `Here is the config:\n\n\`\`\`json\n{\n  "db": {\n    "${ESCAPED_KEY}": "${VALUE}"\n  }\n}\n\`\`\`\n`,
  // a form feed, a backspace and the other short escapes after the key, with one or two backslashes
  `{"body":{"${KEY}\\f":"${VALUE}"},"body":null}`,
  `{"body":{"${KEY}\\\\f":"${VALUE}"},"body":null}`,
  `{"body":{"${KEY}\\b":"${VALUE}"},"body":null}`,
  `{"body":{"${KEY}\\\\b":"${VALUE}"},"body":null}`,
  `[tool] read [{"${KEY}\\f":"${VALUE}"}]`,
  `Here is the config:\n\n\`\`\`json\n{\n  "db": {\n    "${KEY}\\f": "${VALUE}"\n  }\n}\n\`\`\`\n`,
  `${KEY}\\f=${VALUE}`,
  `${KEY}\\v=${VALUE}`,
  `${KEY}\\q:${VALUE}`,
  `${KEY}\f=${VALUE}`,
  `${KEY}\b=${VALUE}`,
  ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-'),
  ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-').replaceAll('-', '\\u002d'),
]

/** Addresses written out, written with an escape, and both at once. */
export const EMAIL_TEXT_CASES: readonly string[] = [
  ADDRESS,
  `{"to":"${ADDRESS}"}`,
  `{"to":"${ADDRESS_U}"}`,
  `${ADDRESS} and ${ADDRESS_U}`,
  `${ADDRESS_U} and ${ADDRESS}`,
  `{"to":"${ADDRESS}","cc":"${ADDRESS_U}"}`,
  `[tool] send {"to":"${ADDRESS_U}"}`,
  `${ADDRESS}\n${ADDRESS_X}`,
]
