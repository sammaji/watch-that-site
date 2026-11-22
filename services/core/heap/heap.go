package heap

import "container/heap"

// PriorityQueue is a generic wrapper around container/heap.
type PriorityQueue[T any] struct {
	data []T
	less func(a, b T) bool
}

// NewPriorityQueue creates an empty priority queue.
// For a Min-Heap, less(a, b) should return true if a < b.
func NewPriorityQueue[T any](less func(a, b T) bool) *PriorityQueue[T] {
	return &PriorityQueue[T]{
		data: make([]T, 0),
		less: less,
	}
}

// NewPriorityQueueFromSlice creates a priority queue from an existing slice in O(N) time.
// It mutates the provided slice in-place to establish the heap property.
func NewPriorityQueueFromSlice[T any](data []T, less func(a, b T) bool) *PriorityQueue[T] {
	pq := &PriorityQueue[T]{
		data: data,
		less: less,
	}
	heap.Init(pq)
	return pq
}

// Push adds an element to the heap.
func (pq *PriorityQueue[T]) PushItem(item T) {
	heap.Push(pq, item)
}

// Pop removes and returns the minimum element from the heap.
func (pq *PriorityQueue[T]) PopItem() T {
	return heap.Pop(pq).(T)
}

// Peek returns the minimum element from the heap without removing it.
func (pq *PriorityQueue[T]) Peek() T {
	return pq.data[0]
}

// Len returns the number of elements in the heap.
func (pq *PriorityQueue[T]) Len() int { return len(pq.data) }

// Less satisfies heap.Interface.
func (pq *PriorityQueue[T]) Less(i, j int) bool {
	return pq.less(pq.data[i], pq.data[j])
}

// Swap satisfies heap.Interface.
func (pq *PriorityQueue[T]) Swap(i, j int) {
	pq.data[i], pq.data[j] = pq.data[j], pq.data[i]
}

// Push satisfies heap.Interface (called internally by container/heap).
func (pq *PriorityQueue[T]) Push(x any) {
	pq.data = append(pq.data, x.(T))
}

// Pop satisfies heap.Interface (called internally by container/heap).
func (pq *PriorityQueue[T]) Pop() any {
	old := pq.data
	n := len(old)
	x := old[n-1]
	pq.data = old[0 : n-1]
	return x
}
