// 改写诊断（方案 §4.10）：每一处兼容改写或值得追溯的事件记一条，写入请求日志；不含正文。
export interface Diagnostic {
  code: string;
  action: 'rewrite' | 'strip' | 'append' | 'passthrough' | 'reject' | 'observe';
  field?: string;
  detail?: string;
  count?: number;
}
