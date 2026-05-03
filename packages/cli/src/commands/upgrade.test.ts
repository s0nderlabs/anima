import { describe, expect, it } from 'bun:test'
import { parseUpgradeArgs } from './upgrade'

describe('parseUpgradeArgs', () => {
  it('empty tail → no ref, no flags', () => {
    expect(parseUpgradeArgs([])).toEqual({
      ref: undefined,
      yes: false,
      reprovision: false,
    })
  })
  it('--yes alone → no ref', () => {
    expect(parseUpgradeArgs(['--yes'])).toEqual({
      ref: undefined,
      yes: true,
      reprovision: false,
    })
  })
  it('positional `latest`', () => {
    expect(parseUpgradeArgs(['latest'])).toEqual({
      ref: 'latest',
      yes: false,
      reprovision: false,
    })
  })
  it('positional tag `v0.17.8`', () => {
    expect(parseUpgradeArgs(['v0.17.8'])).toEqual({
      ref: 'v0.17.8',
      yes: false,
      reprovision: false,
    })
  })
  it('positional + --yes', () => {
    expect(parseUpgradeArgs(['latest', '--yes'])).toEqual({
      ref: 'latest',
      yes: true,
      reprovision: false,
    })
  })
  it('--ref takes priority over positional', () => {
    expect(parseUpgradeArgs(['main', '--ref', 'v0.17.8'])).toEqual({
      ref: 'v0.17.8',
      yes: false,
      reprovision: false,
    })
  })
  it('--ref + --yes', () => {
    expect(parseUpgradeArgs(['--ref', 'v0.17.8', '--yes'])).toEqual({
      ref: 'v0.17.8',
      yes: true,
      reprovision: false,
    })
  })
  it('--reprovision flag captured', () => {
    expect(parseUpgradeArgs(['v0.17.8', '--reprovision', '--yes'])).toEqual({
      ref: 'v0.17.8',
      yes: true,
      reprovision: true,
    })
  })
  it('-y short alias works', () => {
    expect(parseUpgradeArgs(['-y'])).toEqual({
      ref: undefined,
      yes: true,
      reprovision: false,
    })
  })
})
