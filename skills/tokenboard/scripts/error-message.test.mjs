import assert from 'node:assert/strict'
import test from 'node:test'
import { errorMessage } from './error-message.mjs'

test('normalizes ordinary and empty thrown values', () => {
  assert.equal(errorMessage(new Error('failed')), 'failed')
  assert.equal(errorMessage(new Error('')), 'Error')
  assert.equal(errorMessage('failed'), 'failed')
  assert.equal(errorMessage(''), 'Unknown error')
})

test('does not throw while formatting hostile thrown values', () => {
  const throwingString = {
    toString() {
      throw new Error('toString failed')
    }
  }
  const throwingError = new Error('failed')
  Object.defineProperties(throwingError, {
    message: { get: () => { throw new Error('message getter failed') } },
    name: { get: () => { throw new Error('name getter failed') } }
  })

  assert.equal(errorMessage(Object.create(null)), 'Unknown error')
  assert.equal(errorMessage(throwingString), 'Unknown error')
  assert.equal(errorMessage(throwingError), 'Unknown error')
})
