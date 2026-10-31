/** 类名拼接。DESIGN §8.4：样式只用 class，不写内联 style（动态尺寸除外） */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '').join(' ')
}
