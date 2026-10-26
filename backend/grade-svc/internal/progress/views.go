// 统计、背题队列与考点掌握：全部由服务端按同一掌握线（80）计算，前端只渲染。
package progress

import (
	"encoding/json"
	"sort"

	"grade-svc/internal/subject"
)

type ChapterStat struct {
	Name  string `json:"name"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

type Stats struct {
	Done     int           `json:"done"`
	Total    int           `json:"total"`
	Avg      int           `json:"avg"`
	Good     int           `json:"good"`
	Chapters []ChapterStat `json:"chapters"`
}

func buildStats(cfg *subject.Config, records map[int]json.RawMessage) Stats {
	st := Stats{Total: len(cfg.Questions)}
	chDone := make([]int, len(cfg.Chapters))
	chTotal := make([]int, len(cfg.Chapters))
	chIndex := map[string]int{}
	for i, name := range cfg.Chapters {
		chIndex[name] = i
	}
	sum, n := 0, 0
	for i := range cfg.Questions {
		q := &cfg.Questions[i]
		if idx, ok := chIndex[q.Chapter]; ok {
			chTotal[idx]++
		}
		s := scoreOf(records[q.ID])
		if s == nil {
			continue
		}
		st.Done++
		sum += *s
		n++
		if *s >= LowLine {
			st.Good++
		}
		if idx, ok := chIndex[q.Chapter]; ok {
			chDone[idx]++
		}
	}
	if n > 0 {
		st.Avg = int(float64(sum)/float64(n) + 0.5)
	}
	st.Chapters = make([]ChapterStat, 0, len(cfg.Chapters))
	for i, name := range cfg.Chapters {
		st.Chapters = append(st.Chapters, ChapterStat{Name: name, Done: chDone[i], Total: chTotal[i]})
	}
	return st
}

// ReciteItem 是重点优先背队列的一条。
type ReciteItem struct {
	ID     int    `json:"id"`
	Type   string `json:"type"`
	Group  string `json:"group"` // wrong | mid | todo
	Score  *int   `json:"score"`
	Viewed bool   `json:"viewed"`
	Draft  bool   `json:"draft"`
}

type ReciteView struct {
	Items  []ReciteItem `json:"items"`
	Counts ReciteCounts `json:"counts"`
}

type ReciteCounts struct {
	Total  int `json:"total"`
	Wrong  int `json:"wrong"`
	Mid    int `json:"mid"`
	Todo   int `json:"todo"`
	Single int `json:"single"`
	Blank  int `json:"blank"`
	Essay  int `json:"essay"`
}

var groupRank = map[string]int{"wrong": 0, "mid": 1, "todo": 2}
var typeRank = map[string]int{"essay": 0, "blank": 1, "single": 2}

// BuildRecite 生成未掌握队列（≥80 移出）。
func BuildRecite(cfg *subject.Config, records map[int]json.RawMessage) ReciteView {
	items := make([]ReciteItem, 0, len(cfg.Questions))
	counts := ReciteCounts{}
	for i := range cfg.Questions {
		q := &cfg.Questions[i]
		raw, has := records[q.ID]
		s := scoreOf(raw)
		group := "todo"
		if s != nil {
			if *s >= MasterLine {
				continue
			}
			if *s < LowLine {
				group = "wrong"
			} else {
				group = "mid"
			}
		}
		viewed := has && recViewed(raw) != 0
		draft := has && hasU(raw) && s == nil
		items = append(items, ReciteItem{ID: q.ID, Type: q.Type, Group: group, Score: s, Viewed: viewed, Draft: draft})
	}
	sort.SliceStable(items, func(a, b int) bool {
		x, y := items[a], items[b]
		if x.Group != y.Group {
			return groupRank[x.Group] < groupRank[y.Group]
		}
		if x.Score != nil && y.Score != nil && *x.Score != *y.Score {
			return *x.Score < *y.Score
		}
		if x.Group == "todo" && x.Viewed != y.Viewed {
			return x.Viewed
		}
		tx, ok := typeRank[x.Type]
		if !ok {
			tx = 9
		}
		ty, ok := typeRank[y.Type]
		if !ok {
			ty = 9
		}
		if tx != ty {
			return tx < ty
		}
		return x.ID < y.ID
	})
	for _, it := range items {
		counts.Total++
		switch it.Group {
		case "wrong":
			counts.Wrong++
		case "mid":
			counts.Mid++
		case "todo":
			counts.Todo++
		}
		switch it.Type {
		case "single":
			counts.Single++
		case "blank":
			counts.Blank++
		case "essay":
			counts.Essay++
		}
	}
	return ReciteView{Items: items, Counts: counts}
}

// ——— 考前重点记忆 ———

type MemoItem struct {
	D int    `json:"d"`
	T string `json:"t"`
}

type MemoBy struct {
	Wrong int `json:"wrong"`
	Mid   int `json:"mid"`
	Todo  int `json:"todo"`
}

type MemoSection struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Types      []string   `json:"types"`
	Items      []MemoItem `json:"items"`
	IDs        []int      `json:"ids"`
	Status     string     `json:"status"` // pending | master
	PendingIDs []int      `json:"pendingIds"`
	By         MemoBy     `json:"by"`
}

type MemoChapter struct {
	Name     string        `json:"name"`
	Sections []MemoSection `json:"sections"`
	Pending  int           `json:"pending"`
	Total    int           `json:"total"`
}

type MemoCounts struct {
	Chapters      int `json:"chapters"`
	Sections      int `json:"sections"`
	Pending       int `json:"pending"`
	Master        int `json:"master"`
	Questions     int `json:"questions"`
	Mastered      int `json:"mastered"`
	Wrong         int `json:"wrong"`
	Mid           int `json:"mid"`
	Todo          int `json:"todo"`
	Draft         int `json:"draft"`
	SectionsWrong int `json:"sectionsWrong"`
}

type MemoView struct {
	Chapters []MemoChapter `json:"chapters"`
	Counts   MemoCounts    `json:"counts"`
}

type memoDoc struct {
	Chapters []struct {
		Name     string `json:"name"`
		Sections []struct {
			ID    string     `json:"id"`
			Title string     `json:"title"`
			Types []string   `json:"types"`
			Items []MemoItem `json:"items"`
			IDs   []int      `json:"ids"`
		} `json:"sections"`
	} `json:"chapters"`
}

// BuildMemo 计算每个考点小节的掌握情况：所挂题全部 ≥80 才算已掌握。
func BuildMemo(cfg *subject.Config, records map[int]json.RawMessage) MemoView {
	var doc memoDoc
	_ = json.Unmarshal(cfg.Memo, &doc)
	counts := MemoCounts{}
	seen := map[int]bool{}
	chapters := make([]MemoChapter, 0, len(doc.Chapters))
	for _, ch := range doc.Chapters {
		row := MemoChapter{Name: ch.Name}
		for _, sec := range ch.Sections {
			ids := sec.IDs
			if ids == nil {
				ids = []int{}
			}
			pending := make([]int, 0)
			by := MemoBy{}
			for _, id := range ids {
				s := scoreOf(records[id])
				if s != nil && *s >= MasterLine {
					if !seen[id] {
						seen[id] = true
						counts.Mastered++
					}
					continue
				}
				st := "todo"
				if s != nil {
					if *s < LowLine {
						st = "wrong"
					} else {
						st = "mid"
					}
				}
				switch st {
				case "wrong":
					by.Wrong++
				case "mid":
					by.Mid++
				default:
					by.Todo++
				}
				pending = append(pending, id)
				if seen[id] {
					continue
				}
				seen[id] = true
				switch st {
				case "wrong":
					counts.Wrong++
				case "mid":
					counts.Mid++
				default:
					counts.Todo++
					if hasU(records[id]) {
						counts.Draft++
					}
				}
			}
			status := "master"
			if len(ids) == 0 || len(pending) > 0 {
				status = "pending"
			}
			if by.Wrong > 0 {
				counts.SectionsWrong++
			}
			types := sec.Types
			if types == nil {
				types = []string{}
			}
			items := sec.Items
			if items == nil {
				items = []MemoItem{}
			}
			row.Sections = append(row.Sections, MemoSection{
				ID: sec.ID, Title: sec.Title, Types: types, Items: items, IDs: ids,
				Status: status, PendingIDs: pending, By: by,
			})
			row.Total++
			counts.Sections++
			if status == "pending" {
				row.Pending++
				counts.Pending++
			} else {
				counts.Master++
			}
		}
		chapters = append(chapters, row)
		counts.Chapters++
	}
	counts.Questions = counts.Mastered + counts.Wrong + counts.Mid + counts.Todo
	return MemoView{Chapters: chapters, Counts: counts}
}
