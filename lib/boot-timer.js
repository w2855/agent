'use strict';

/* 启动阶段打点计时器（纯逻辑，node 直跑可测：tools/y2-check.js）。
 *
 * 串行阶段模型：begin(A) → mark(B) → mark(C) → end()
 *   stages() = { A: tB-tA, B: tC-tB, C: tEnd-tC }
 * 首个阶段覆盖 begin → 第一个 mark（含模块 require 等启动期工作）；
 * 最后一个阶段由 end() 关闭。时间源由构造参数注入（默认 Date.now），
 * 测试传假时钟即可做确定性断言。
 *
 * end() 之前 stages() 也允许读取：未关闭的最后一个阶段值为 null。
 * 这对应「did-finish-load 已到、渲染层 renderer-ready 未上报」的窗口期——
 * 主进程先落一条部分 boot-stages 记录，渲染层上报后再补完整记录。
 */

/** 启动打点：spawn（进程拉起）→ whenReady → createWindow → did-finish-load → renderer-ready */
const BOOT_STAGE_NAMES = ['spawn', 'whenReady', 'createWindow', 'did-finish-load', 'renderer-ready'];

class BootTimer {
  /** @param {() => number} [now] 时间源（默认 Date.now） */
  constructor(now = Date.now) {
    if (typeof now !== 'function') throw new Error('BootTimer: 时间源必须是函数');
    this._now = now;
    /** @type {Array<{ name: string, at: number }>} 有序打点（首项来自 begin） */
    this._marks = [];
    /** end() 时刻；未结束时为 null */
    this._endTime = null;
    this._begun = false;
    this._ended = false;
  }

  /** 是否已 end()（调用方据此决定落部分记录还是完整记录）。 */
  get ended() { return this._ended; }

  /** 是否已打过名为 name 的点（同名 mark 会抛错，重复路径调用前先查它）。 */
  has(name) {
    return this._marks.some((m) => m.name === name);
  }

  /** 打开第一个阶段（整个生命周期只允许一次）。 */
  begin(name = 'spawn', at) {
    this._assertName(name);
    this._assertAt(at);
    if (this._begun) throw new Error('BootTimer: begin 只能调用一次');
    this._marks.push({ name, at: at === undefined ? this._now() : at });
    this._begun = true;
  }

  /** 关闭当前阶段、打开名为 name 的新阶段。 */
  mark(name, at) {
    if (!this._begun) throw new Error('BootTimer: mark 前必须先 begin');
    if (this._ended) throw new Error('BootTimer: end 之后不能再 mark');
    this._assertName(name);
    this._assertAt(at);
    if (this._marks.some((m) => m.name === name)) {
      throw new Error(`BootTimer: 阶段名重复「${name}」`);
    }
    this._marks.push({ name, at: at === undefined ? this._now() : at });
  }

  /** 关闭最后一个阶段（只允许一次）。 */
  end(at) {
    if (!this._begun) throw new Error('BootTimer: end 前必须先 begin');
    if (this._ended) throw new Error('BootTimer: end 只能调用一次');
    this._assertAt(at);
    this._endTime = at === undefined ? this._now() : at;
    this._ended = true;
  }

  /** 阶段耗时对象：已关闭阶段为毫秒数，未结束的最后一个阶段为 null。 */
  stages() {
    if (!this._begun) return null;
    const out = {};
    for (let i = 0; i < this._marks.length - 1; i++) {
      out[this._marks[i].name] = Math.max(0, this._marks[i + 1].at - this._marks[i].at);
    }
    const last = this._marks[this._marks.length - 1];
    out[last.name] = this._ended ? Math.max(0, this._endTime - last.at) : null;
    return out;
  }

  /** 汇总快照：stages（各阶段耗时）+ open（未关闭的阶段名，全部关闭为 null）+ total（总耗时，未结束为 null）。 */
  snapshot() {
    const stages = this.stages();
    if (!stages) return { stages: {}, open: null, total: null };
    const names = this._marks.map((m) => m.name);
    const open = this._ended ? null : names[names.length - 1];
    const total = this._ended ? Math.max(0, this._endTime - this._marks[0].at) : null;
    return { stages, open, total };
  }

  _assertName(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('BootTimer: 阶段名必须是非空字符串');
    }
  }

  _assertAt(at) {
    if (at !== undefined && !Number.isFinite(at)) {
      throw new Error('BootTimer: 时间戳必须是有限数字');
    }
  }
}

module.exports = { BootTimer, BOOT_STAGE_NAMES };
