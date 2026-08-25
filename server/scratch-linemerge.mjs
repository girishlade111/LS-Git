import { threeWayMerge } from '../src/lib/linemerge.js'

const r1 = threeWayMerge('a\nb\nc\nd\n', 'a\nB1\nc\nd\n', 'a\nb\nc\nD1\n')
console.log('clean:', JSON.stringify(r1))

const r2 = threeWayMerge('x\n', 'ours\n', 'theirs\n')
console.log('conflict count:', r2.conflicts.length, 'lines:', r2.lines)

const r3 = threeWayMerge('x\n', 'same\n', 'same\n')
console.log('identical:', JSON.stringify(r3.lines))

const r4 = threeWayMerge('a\nb\nc\n', 'a\nc\n', 'a\nb2\nc\n')
console.log('delvskeep:', JSON.stringify(r4.lines))

// insertion vs insertion at same gap, different content
const r5 = threeWayMerge('a\nz\n', 'a\nINS-O\nz\n', 'a\nINS-T\nz\n')
console.log('ins-vs-ins:', r5.conflicts.length)

// both append different tails
const r6 = threeWayMerge('head\n', 'head\nO-tail\n', 'head\nT-tail\n')
console.log('tails:', JSON.stringify(r6))
