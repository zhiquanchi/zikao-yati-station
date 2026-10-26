// 判分引擎（Go 唯一实现）：单选全等、填空严格全等（并列多空可跨空互换）、
// 简答得分点覆盖度。口径逐函数移植自原 frontend/grading.js，前端不再保留任何判分代码。
// 纯函数、无 IO，便于表驱动测试。
package grading

import (
	"math"
	"regexp"
	"strings"
	"unicode"
)

// Result 是一次判分的统一返回；Per 的条目形状随题型不同：
//
//	single: nil
//	blank:  {ok,input,expect}
//	essay:  {text,cov,state,segs}
type Result struct {
	Score  int    `json:"score"`
	Engine string `json:"engine"`
	Per    []any  `json:"per"`
}

type BlankPoint struct {
	OK     bool   `json:"ok"`
	Input  string `json:"input"`
	Expect string `json:"expect"`
}

type EssayPoint struct {
	Text  string   `json:"text"`
	Cov   float64  `json:"cov"`
	State string   `json:"state"`
	Segs  []string `json:"segs"`
}

// stop：虚词/高频套话字，组成的二字组合不计入要点特征。
var stop = map[rune]bool{}

func init() {
	for _, r := range "的了和与及是在有等指为对将把被从这那其个中通过然后并且或者但如因于用则而之要能会可各所统" {
		stop[r] = true
	}
}

// isPunctOrSpace 与原 PUNCT 正则同集合（含空白、全角空格）。
func isPunctOrSpace(r rune) bool {
	if unicode.IsSpace(r) {
		return true
	}
	switch r {
	case '。', '，', '、', '；', '：', '？', '！', '“', '”', '‘', '’', '（', '）',
		'(', ')', '《', '》', '〈', '〉', '【', '】', '〔', '〕', '｛', '｝', '{', '}',
		'·', '…', '—', '～', '-', '_', '/', '\\', '\'', '"', '`', '~', '!', '@', '#', '$',
		'%', '^', '&', '*', '+', '=', '<', '>', '|', ';', ':', ',', '.':
		return true
	}
	return false
}

// Fw2H 全角转半角（FF01-FF5E 平移 0xFEE0），全角空格转普通空格。
func Fw2H(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0xFF01 && r <= 0xFF5E {
			return r - 0xFEE0
		}
		if r == 0x3000 {
			return ' '
		}
		return r
	}, s)
}

// Flat 扁平化：小写、去空白标点，只留汉字/字母/数字。
func Flat(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(Fw2H(s)) {
		if isPunctOrSpace(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

type tokenSet struct {
	bi map[string]bool
	la map[string]bool
	n  int
}

func runes(s string) []rune { return []rune(s) }

func isHan(r rune) bool { return unicode.Is(unicode.Han, r) }
func isAlnum(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
}

// Tokens 分词：CJK 二字组合（两字都不在虚词表）+ 字母数字词（长度≥2）。
func Tokens(s string) tokenSet {
	rs := runes(strings.ToLower(Fw2H(s)))
	bi := map[string]bool{}
	la := map[string]bool{}
	for i := 0; i < len(rs); {
		if isHan(rs[i]) {
			j := i
			for j < len(rs) && isHan(rs[j]) {
				j++
			}
			for k := i; k+1 < j; k++ {
				if stop[rs[k]] || stop[rs[k+1]] {
					continue
				}
				bi[string(rs[k:k+2])] = true
			}
			i = j
			continue
		}
		if isAlnum(rs[i]) {
			j := i
			for j < len(rs) && isAlnum(rs[j]) {
				j++
			}
			if j-i >= 2 {
				la[string(rs[i:j])] = true
			}
			i = j
			continue
		}
		i++
	}
	return tokenSet{bi: bi, la: la, n: len(bi) + len(la)}
}

func (t tokenSet) hasBi(g string) bool { return t.bi[g] }
func (t tokenSet) hasLa(g string) bool { return t.la[g] }

// CommonRuns 求两段文本互配的公共片段（长度≥min），按最长优先、互不重叠。
func CommonRuns(a, b string, min int) []string {
	if min <= 0 {
		min = 3
	}
	ra, rb := runes(a), runes(b)
	if len(ra) < min || len(rb) < min {
		return []string{}
	}
	runs := make([]string, 0, 4)
	used := make([]bool, len(rb))
	sa := ra
	for len(sa) >= min && len(rb) >= min {
		best, endA := 0, 0
		prev := make([]int, len(rb)+1)
		for i := 1; i <= len(sa); i++ {
			cur := make([]int, len(rb)+1)
			for j := 1; j <= len(rb); j++ {
				if sa[i-1] == rb[j-1] && !used[j-1] {
					cur[j] = prev[j-1] + 1
					if cur[j] > best {
						best = cur[j]
						endA = i
					}
				}
			}
			prev = cur
		}
		if best < min {
			break
		}
		seg := string(sa[endA-best : endA])
		pos := indexRunes(rb, runes(seg))
		if pos < 0 {
			break
		}
		for k := pos; k < pos+best && k < len(rb); k++ {
			used[k] = true
		}
		runs = append(runs, seg)
		sa = removeFirstRunes(sa, runes(seg))
	}
	return runs
}

func indexRunes(hay, needle []rune) int {
	if len(needle) == 0 || len(needle) > len(hay) {
		return -1
	}
	for i := 0; i+len(needle) <= len(hay); i++ {
		ok := true
		for j := range needle {
			if hay[i+j] != needle[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

func removeFirstRunes(hay, needle []rune) []rune {
	pos := indexRunes(hay, needle)
	if pos < 0 {
		return hay
	}
	out := make([]rune, 0, len(hay)-len(needle))
	out = append(out, hay[:pos]...)
	out = append(out, hay[pos+len(needle):]...)
	return out
}

type ctx struct {
	df    map[string]int
	total int
}

func ctxFor(points []string) ctx {
	c := ctx{df: map[string]int{}, total: len(points)}
	for _, p := range points {
		for g := range Tokens(p).bi {
			c.df[g]++
		}
	}
	return c
}

var leadRe = regexp.MustCompile(`^([^：:，,、。\s]{2,10})[：:]`)

// PointCoverage 计算单个得分点与整题作答的覆盖度（0~1）。
func PointCoverage(point, userText string, c ctx) (float64, []string) {
	pf := Flat(point)
	uf := Flat(userText)
	if uf == "" {
		return 0, []string{}
	}
	cov := 0.0
	pt := Tokens(point)
	ut := Tokens(userText)
	if pt.n > 0 {
		hit, tot := 0.0, 0.0
		weight := func(g string) float64 {
			if c.total == 0 {
				return 1
			}
			df := c.df[g]
			return 1 + 1.5*(1-float64(df)/float64(c.total))
		}
		for g := range pt.bi {
			w := weight(g)
			tot += w
			if ut.hasBi(g) {
				hit += w
			}
		}
		for w0 := range pt.la {
			tot++
			if ut.hasLa(w0) {
				hit++
			}
		}
		cov = hit / tot
	}
	// 字面重合度兜底：概括性作答按内容字覆盖比例给分（短要点权重更高）
	chars := map[rune]bool{}
	for _, ch := range pf {
		if isHan(ch) && !stop[ch] {
			chars[ch] = true
		}
	}
	if len(chars) > 0 {
		h := 0
		for ch := range chars {
			if strings.ContainsRune(uf, ch) {
				h++
			}
		}
		w := 0.7
		if pt.n <= 10 {
			w = 0.9
		}
		cov = math.Max(cov, float64(h)/float64(len(chars))*w)
	}
	pr := runes(pf)
	ur := runes(uf)
	if len(pr) >= 4 && strings.Contains(uf, pf) {
		cov = 1
	} else if len(ur) >= 2 && strings.Contains(pf, uf) {
		cov = math.Max(cov, float64(len(ur))/float64(len(pr)))
	}
	if m := leadRe.FindStringSubmatch(point); m != nil {
		lf := Flat(m[1])
		ls := 0.0
		if strings.Contains(uf, lf) {
			ls = 1
		} else {
			lt := Tokens(lf)
			if lt.n > 0 {
				h := 0
				for g := range lt.bi {
					if ut.hasBi(g) {
						h++
					}
				}
				ls = float64(h) / float64(lt.n)
			}
		}
		if ls >= 0.6 {
			cov = math.Max(cov, 0.6)
		}
	}
	if cov > 1 {
		cov = 1
	}
	return cov, CommonRuns(uf, pf, 3)
}

// StateOf 覆盖度→状态（与前端展示共用阈值）。
func StateOf(cov float64) string {
	switch {
	case cov >= 0.5:
		return "hit"
	case cov >= 0.22:
		return "part"
	default:
		return "miss"
	}
}

// GradeEssay 简答：各要点覆盖度均值×100。
func GradeEssay(userText string, points []string) Result {
	c := ctxFor(points)
	per := make([]any, 0, len(points))
	sum := 0.0
	for _, p := range points {
		cov, segs := PointCoverage(p, userText, c)
		sum += cov
		per = append(per, EssayPoint{Text: p, Cov: cov, State: StateOf(cov), Segs: segs})
	}
	score := 0
	if len(points) > 0 {
		score = int(math.Round(sum / float64(len(points)) * 100))
	}
	return Result{Score: score, Engine: "local", Per: per}
}

// NormStrict 严格比较归一：仅容忍全/半角、大小写与空白。
func NormStrict(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, Fw2H(s))
}

// BlankMatch 单个填空：完全一致才得分；loose 仅用于 fallback（整句参考答案）的包含兜底。
func BlankMatch(userInput string, variants []string, loose bool) bool {
	un := NormStrict(userInput)
	if un == "" {
		return false
	}
	for _, v := range variants {
		vn := NormStrict(v)
		if vn == "" {
			continue
		}
		if un == vn {
			return true
		}
		if loose {
			uc, vc := len(runes(un)), len(runes(vn))
			if (vc >= 2 && strings.Contains(un, vn)) || (uc >= 2 && strings.Contains(vn, un)) {
				return true
			}
		}
	}
	return false
}

// GradeBlanks 填空整题：可互换题（unordered）取「输入→空位」全排列的最大命中数；
// 每空仍按 BlankMatch 严格口径。n>7 不做排列（避免阶乘爆炸）。
func GradeBlanks(inputs []string, blanks [][]string, unordered, fallback bool) Result {
	n := len(blanks)
	loose := fallback
	matchAt := func(inpIdx, slotIdx int) bool {
		in := ""
		if inpIdx >= 0 && inpIdx < len(inputs) {
			in = inputs[inpIdx]
		}
		return BlankMatch(in, blanks[slotIdx], loose)
	}
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	if unordered && !loose && n >= 2 && n <= 7 {
		bestHits := -1
		used := make([]bool, n)
		cur := make([]int, n)
		var rec func(fixed int)
		rec = func(fixed int) {
			if fixed == n {
				hits := 0
				for i := 0; i < n; i++ {
					if matchAt(i, cur[i]) {
						hits++
					}
				}
				if hits > bestHits {
					bestHits = hits
					copy(order, cur)
				}
				return
			}
			for s := 0; s < n; s++ {
				if used[s] {
					continue
				}
				used[s] = true
				cur[fixed] = s
				rec(fixed + 1)
				used[s] = false
			}
		}
		rec(0)
	}
	per := make([]any, n)
	okCount := 0
	for i := 0; i < n; i++ {
		in := ""
		if i < len(inputs) {
			in = strings.TrimSpace(inputs[i])
		}
		ok := matchAt(i, order[i])
		if ok {
			okCount++
		}
		expect := ""
		if len(blanks[i]) > 0 {
			expect = blanks[i][0]
		}
		per[i] = BlankPoint{OK: ok, Input: in, Expect: expect}
	}
	score := 0
	if n > 0 {
		score = int(math.Round(float64(okCount) / float64(n) * 100))
	}
	return Result{Score: score, Engine: "local", Per: per}
}

// GradeSingle 单选：完全一致才得分。
func GradeSingle(choice, answer string) Result {
	if choice == answer {
		return Result{Score: 100, Engine: "local"}
	}
	return Result{Score: 0, Engine: "local"}
}
