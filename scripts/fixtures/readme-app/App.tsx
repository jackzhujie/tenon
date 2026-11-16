import { useMemo, useState } from 'react'

type Status = 'pending' | 'approved' | 'rejected'

interface Item {
  readonly id: string
  readonly who: string
  readonly what: string
  readonly amount: number
  readonly status: Status
  readonly when: string
}

const SEED: readonly Item[] = [
  { id: 'A-1042', who: '陈静', what: '客户拜访交通费（上海往返）', amount: 486, status: 'pending', when: '今天 09:12' },
  { id: 'A-1041', who: '李岩', what: '团队团建晚餐 · 6 人', amount: 1280, status: 'pending', when: '昨天 18:40' },
  { id: 'A-1039', who: '王雨桐', what: '云服务器续费 · 3 个月', amount: 2340, status: 'approved', when: '11-14' },
  { id: 'A-1036', who: '周牧', what: '办公椅（人体工学）', amount: 1699, status: 'rejected', when: '11-13' },
  { id: 'A-1033', who: '陈静', what: '印刷物料 · 展会折页 500 份', amount: 860, status: 'approved', when: '11-12' },
]

const LABEL: Record<Status, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
}

export function App({ appName }: { appName: string }) {
  const [items, setItems] = useState<readonly Item[]>(SEED)
  const [tab, setTab] = useState<'all' | Status>('all')

  const shown = useMemo(
    () => (tab === 'all' ? items : items.filter((item) => item.status === tab)),
    [items, tab],
  )
  const pending = items.filter((item) => item.status === 'pending')
  const total = pending.reduce((sum, item) => sum + item.amount, 0)

  function settle(id: string, status: Status): void {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, status } : item)))
  }

  return (
    <div className="shell">
      <header className="head">
        <div>
          <p className="eyebrow">财务 · 报销</p>
          <h1>{appName}</h1>
        </div>
        <div className="summary">
          <span className="num">{pending.length}</span>
          <span className="cap">笔待审</span>
          <span className="amount">¥{total.toLocaleString()}</span>
        </div>
      </header>

      <nav className="tabs">
        {(['all', 'pending', 'approved', 'rejected'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'tab on' : 'tab'}
            onClick={() => setTab(key)}
          >
            {key === 'all' ? '全部' : LABEL[key]}
          </button>
        ))}
      </nav>

      <ul className="list">
        {shown.map((item) => (
          <li key={item.id} className="row">
            <div className="who">
              <span className="avatar">{item.who.slice(0, 1)}</span>
              <div>
                <p className="name">
                  {item.who} <span className="id">{item.id}</span>
                </p>
                <p className="what">{item.what}</p>
              </div>
            </div>
            <div className="right">
              <span className="money">¥{item.amount.toLocaleString()}</span>
              <span className={'badge ' + item.status}>{LABEL[item.status]}</span>
              {item.status === 'pending' ? (
                <span className="actions">
                  <button type="button" className="ok" onClick={() => settle(item.id, 'approved')}>
                    通过
                  </button>
                  <button type="button" className="no" onClick={() => settle(item.id, 'rejected')}>
                    驳回
                  </button>
                </span>
              ) : (
                <span className="when">{item.when}</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      <footer className="foot">
        数据存在这台机器上 · 每一轮改动都是一个 Git 提交，随时可回滚
      </footer>
    </div>
  )
}
