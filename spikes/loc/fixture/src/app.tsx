import { Button } from './components/ui/button'
import { Card } from './components/ui/card'

export function App() {
  return (
    <main className="p-6 space-y-4">
      <h1 className="text-2xl font-semibold">商品管理</h1>
      <Card title="商品列表">
        <ul className="divide-y">
          <li className="py-2">苹果</li>
          <li className="py-2">香蕉</li>
        </ul>
        <Button variant="outline" className="mt-2">
          新增商品
        </Button>
      </Card>
    </main>
  )
}
