package com.tmu.mobile;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.content.Context;
import android.os.SystemClock;
import android.graphics.*;
import android.text.TextPaint;
import android.text.TextUtils;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.*;

/** Numbers are actual samples; only the ring, bar and final plotted segment interpolate. */
final class HostCard extends View {
    interface Observer {
        boolean animationsVisible();
        void animationStarted(ValueAnimator animator);
        void animationFinished(ValueAnimator animator);
        void animatedFrame();
    }

    private final Observer observer;
    private final boolean online,animate;
    private final int accent;
    private final double cpu,memory,previousCpu,previousMemory;
    private final String name,model,time,cpuText,memoryText,temperatureText,temperatureLabel,memoryBytes,network,power,error;
    private final float[] history;
    private final TextPaint textPaint=new TextPaint(Paint.ANTI_ALIAS_FLAG);
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path=new Path();
    private final RectF rect=new RectF();
    private final float density,fontDensity;
    private Shader background;
    private float phase=1f;
    private ValueAnimator animator;
    private long lastFrameAt=0;

    HostCard(Context context,String id,JSONObject host,List<Float> samples,double oldCpu,double oldMemory,boolean animate,Observer observer) {
        super(context);
        this.observer=observer;this.animate=animate;
        density=getResources().getDisplayMetrics().density;fontDensity=getResources().getDisplayMetrics().scaledDensity;
        online=host.optBoolean("online");name=id.equals("mac")?"MacBook":id.equals("n100")?"N100":"Win 11";
        accent=id.equals("mac")?Color.rgb(121,191,255):id.equals("n100")?Color.rgb(184,239,111):Color.rgb(196,167,255);
        JSONObject c=object(host,"cpu"),m=object(host,"memory"),p=object(host,"power"),g=object(host,"gpu"),b=object(host,"battery"),n=object(host,"network");
        cpu=number(c,"usage");memory=number(m,"percent");previousCpu=Double.isFinite(oldCpu)?oldCpu:0;previousMemory=Double.isFinite(oldMemory)?oldMemory:0;
        model=c.optString("model",id.equals("win11")?"Windows 设备":"等待连接");
        long sourceTime=host.optLong("sampledAt",0);
        time=sourceTime>0?"采样 "+new SimpleDateFormat("HH:mm:ss",Locale.CHINA).format(new Date(sourceTime)):"";
        cpuText=format(cpu,"%",0);memoryText=format(memory,"%",0);
        double temperature=number(p,"temperature");
        temperatureLabel=Double.isFinite(temperature)?p.optString("temperatureLabel","CPU 温度"):Double.isFinite(number(g,"temperature"))?g.optString("temperatureLabel","GPU 温度"):"温度";
        if(!Double.isFinite(temperature))temperature=number(g,"temperature");
        temperatureText=format(temperature,"℃",1);
        memoryBytes=size(number(m,"used"))+" / "+size(number(m,"total"));
        network="↓ "+rate(number(n,"rxBps"))+"   ↑ "+rate(number(n,"txBps"));
        double watts=number(p,"cpu");
        if(Double.isFinite(watts))power="CPU "+format(watts," W",1);
        else if(Double.isFinite(number(b,"watts"))){String state=b.optString("status");power=(state.equals("discharging")?"放电 ":state.equals("charging")?"充电 ":"电池 ")+format(Math.abs(number(b,"watts"))," W",1);}
        else power="功耗 —";
        error=host.optString("error","等待设备上线或完成连接配置");
        history=new float[samples==null?0:samples.size()];for(int i=0;i<history.length;i++)history[i]=samples.get(i);
        setFocusable(true);setClickable(true);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        setContentDescription(name+"，"+(online?"在线，CPU "+cpuText+"，内存 "+memoryText+"，"+temperatureLabel+" "+temperatureText+"，"+memoryBytes+"，"+power+"，"+network+"，"+time:"离线，"+error)+"。点按查看详情");
    }

    private static JSONObject object(JSONObject p,String key){JSONObject o=p.optJSONObject(key);return o==null?new JSONObject():o;}
    private static double number(JSONObject p,String key){if(p.isNull(key))return Double.NaN;double v=p.optDouble(key,Double.NaN);return Double.isFinite(v)?v:Double.NaN;}
    private static String format(double n,String unit,int precision){return Double.isFinite(n)?String.format(Locale.CHINA,"%."+precision+"f",n)+unit:"—";}
    private static String size(double n){if(!Double.isFinite(n))return "—";if(n>=1073741824)return format(n/1073741824," GiB",1);if(n>=1048576)return format(n/1048576," MiB",0);if(n>=1024)return format(n/1024," KiB",0);return format(n," B",0);}
    private static String rate(double n){return Double.isFinite(n)?size(n)+"/s":"—";}
    private float d(float n){return n*density;}
    private int alpha(int color,int a){return Color.argb(Math.max(0,Math.min(255,a)),Color.red(color),Color.green(color),Color.blue(color));}
    private double bounded(double n){return Double.isFinite(n)?Math.max(0,Math.min(100,n)):0;}

    @Override protected void onMeasure(int width,int height){float scale=getResources().getConfiguration().fontScale;int desired=Math.round(d(online?184:126)+Math.max(0,scale-1)*d(40));setMeasuredDimension(resolveSize(getSuggestedMinimumWidth(),width),resolveSize(desired,height));}
    @Override protected void onSizeChanged(int w,int h,int oldW,int oldH){background=new LinearGradient(0,0,w,h,new int[]{Color.rgb(28,44,59),Color.rgb(22,33,46)},null,Shader.TileMode.CLAMP);}
    @Override protected void onAttachedToWindow(){super.onAttachedToWindow();if(online&&animate&&observer.animationsVisible()&&ValueAnimator.areAnimatorsEnabled()){
        phase=0;animator=ValueAnimator.ofFloat(0,1);animator.setDuration(650);animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(a->{phase=(float)a.getAnimatedValue();long now=SystemClock.uptimeMillis();if(now-lastFrameAt>=33||phase>=1){lastFrameAt=now;invalidate();}});
        animator.addListener(new AnimatorListenerAdapter(){@Override public void onAnimationEnd(Animator a){phase=1;observer.animationFinished((ValueAnimator)a);invalidate();}@Override public void onAnimationCancel(Animator a){phase=1;observer.animationFinished((ValueAnimator)a);}});
        observer.animationStarted(animator);animator.start();
    }}
    @Override protected void onDetachedFromWindow(){if(animator!=null)animator.cancel();super.onDetachedFromWindow();}

    private void label(Canvas canvas,String value,float x,float y,float sp,int color,boolean bold,Paint.Align align,float maxWidth){
        textPaint.setColor(color);textPaint.setTypeface(bold?Typeface.DEFAULT_BOLD:Typeface.DEFAULT);textPaint.setTextAlign(align);textPaint.setTextSize(sp*fontDensity);
        if(maxWidth>0&&textPaint.measureText(value)>maxWidth)textPaint.setTextSize(textPaint.getTextSize()*maxWidth/textPaint.measureText(value));
        canvas.drawText(value,x,y,textPaint);
    }
    private void model(Canvas canvas,String value,float x,float y,float maxWidth){textPaint.setColor(MainActivity.MUTED);textPaint.setTextAlign(Paint.Align.LEFT);textPaint.setTypeface(Typeface.DEFAULT);textPaint.setTextSize(10*fontDensity);canvas.drawText(TextUtils.ellipsize(value,textPaint,maxWidth,TextUtils.TruncateAt.END).toString(),x,y,textPaint);}

    @Override protected void onDraw(Canvas canvas){super.onDraw(canvas);if(animator!=null&&animator.isRunning())observer.animatedFrame();
        float w=getWidth(),h=getHeight(),p=d(15),inner=w-p*2,col=inner/3;
        paint.setShader(background);paint.setStyle(Paint.Style.FILL);rect.set(0,0,w,h);canvas.drawRoundRect(rect,d(18),d(18),paint);paint.setShader(null);
        paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(d(1));paint.setColor(alpha(accent,online?(int)(20+45*(1-phase)):15));rect.set(d(.5f),d(.5f),w-d(.5f),h-d(.5f));canvas.drawRoundRect(rect,d(18),d(18),paint);paint.setStyle(Paint.Style.FILL);
        label(canvas,name,p,d(29),19,MainActivity.TEXT,true,Paint.Align.LEFT,inner-d(75));
        float badgeW=d(57);rect.set(w-p-badgeW,d(13),w-p,d(36));paint.setColor(alpha(online?accent:MainActivity.MUTED,18));canvas.drawRoundRect(rect,d(12),d(12),paint);paint.setColor(online?accent:MainActivity.MUTED);canvas.drawCircle(w-p-badgeW+d(10),d(24.5f),d(2.3f),paint);label(canvas,online?"在线":"离线",w-p-d(10),d(28.5f),10,online?accent:MainActivity.MUTED,false,Paint.Align.RIGHT,d(30));
        model(canvas,model,p,d(48),inner-d(89));if(online)label(canvas,time,w-p,d(48),8.5f,MainActivity.MUTED,false,Paint.Align.RIGHT,d(88));
        if(!online){label(canvas,"暂时无法读取",p,d(81),15,MainActivity.MUTED,true,Paint.Align.LEFT,inner);model(canvas,error,p,d(105),inner);return;}

        float x0=p+col*.5f,x1=p+col*1.5f,x2=p+col*2.5f;
        label(canvas,"CPU",x0,d(68),10.5f,MainActivity.MUTED,false,Paint.Align.CENTER,col-d(4));
        label(canvas,"内存",x1,d(68),10.5f,MainActivity.MUTED,false,Paint.Align.CENTER,col-d(4));
        label(canvas,temperatureLabel,x2,d(68),10.5f,MainActivity.MUTED,false,Paint.Align.CENTER,col-d(4));
        float radius=d(24);rect.set(x0-radius,d(99)-radius,x0+radius,d(99)+radius);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(d(3));paint.setStrokeCap(Paint.Cap.ROUND);paint.setColor(alpha(accent,28));canvas.drawArc(rect,-90,360,false,paint);
        if(Double.isFinite(cpu)){paint.setColor(accent);float v=(float)(bounded(previousCpu)+(bounded(cpu)-bounded(previousCpu))*phase);canvas.drawArc(rect,-90,v*3.6f,false,paint);}paint.setStyle(Paint.Style.FILL);
        label(canvas,cpuText,x0,d(106),19,accent,true,Paint.Align.CENTER,col-d(13));
        label(canvas,memoryText,x1,d(102),23,MainActivity.TEXT,true,Paint.Align.CENTER,col-d(6));
        label(canvas,temperatureText,x2,d(102),22,MainActivity.TEXT,true,Paint.Align.CENTER,col-d(6));
        float barLeft=x1-col*.31f,barRight=x1+col*.31f;rect.set(barLeft,d(110),barRight,d(113));paint.setColor(alpha(accent,24));canvas.drawRoundRect(rect,d(2),d(2),paint);
        if(Double.isFinite(memory)){float v=(float)(bounded(previousMemory)+(bounded(memory)-bounded(previousMemory))*phase);rect.right=barLeft+(barRight-barLeft)*v/100;paint.setColor(alpha(accent,170));canvas.drawRoundRect(rect,d(2),d(2),paint);}
        label(canvas,memoryBytes,x1,d(126),8.5f,MainActivity.MUTED,false,Paint.Align.CENTER,col+d(12));
        graph(canvas,p,d(135),inner,d(20));
        label(canvas,network,p,h-d(13),9.5f,MainActivity.MUTED,false,Paint.Align.LEFT,inner*.64f);
        label(canvas,power,w-p,h-d(13),10,MainActivity.TEXT,false,Paint.Align.RIGHT,inner*.33f);
    }

    private void graph(Canvas canvas,float left,float top,float width,float height){
        paint.setStrokeWidth(d(.7f));paint.setColor(Color.rgb(46,64,80));canvas.drawLine(left,top+height,left+width,top+height,paint);
        if(history.length==0)return;
        float step=width/59f,x0=left+width-(history.length-1)*step;path.reset();boolean pen=false;
        for(int i=0;i<history.length-1;i++){float v=history[i];if(!Float.isFinite(v)){pen=false;continue;}float x=x0+i*step,y=top+height-(float)bounded(v)/100*height;if(!pen){path.moveTo(x,y);pen=true;}else path.lineTo(x,y);}
        paint.setColor(accent);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(d(1.6f));paint.setStrokeJoin(Paint.Join.ROUND);canvas.drawPath(path,paint);
        int last=history.length-1;float v=history[last];if(Float.isFinite(v)){
            float x=x0+last*step,y=top+height-(float)bounded(v)/100*height;
            if(last>0&&Float.isFinite(history[last-1])){float previousY=top+height-(float)bounded(history[last-1])/100*height;float start=x-step;canvas.drawLine(start,previousY,start+step*phase,previousY+(y-previousY)*phase,paint);x=start+step*phase;y=previousY+(y-previousY)*phase;}
            paint.setStyle(Paint.Style.FILL);paint.setColor(alpha(accent,40));canvas.drawCircle(x,y,d(4)*(1.5f-phase*.5f),paint);paint.setColor(accent);canvas.drawCircle(x,y,d(2),paint);
        }
        paint.setStyle(Paint.Style.FILL);
    }
}
